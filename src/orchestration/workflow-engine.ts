import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { appendFile, mkdir, writeFile, readFile } from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('workflow-engine');

const RUNTIME_DIR = path.join(process.cwd(), 'runtime');
const WORKFLOWS_STATE_DIR = path.join(RUNTIME_DIR, 'workflows');
const DLQ_PATH = path.join(RUNTIME_DIR, 'workflow-dlq.jsonl');

export interface WorkflowTrigger {
  type: 'manual' | 'schedule' | 'event' | 'label';
  config: Record<string, unknown>;
}

export interface WorkflowRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export interface WorkflowStep {
  id: string;
  name: string;
  action: string;
  params?: Record<string, unknown>;
  onSuccess?: string;
  onFailure?: string;
  retryPolicy?: WorkflowRetryPolicy;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  startedAt: Date;
  completedAt?: Date;
  success: boolean;
  stepResults: Record<string, StepRunResult>;
  error?: string;
  input?: Record<string, unknown>;
}

interface StepRunResult {
  stepId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  attempts: number;
}

const DEFAULT_RETRY_POLICY: WorkflowRetryPolicy = {
  maxRetries: 0,
  initialDelayMs: 500,
  backoffMultiplier: 2,
};

export class WorkflowEngine extends EventEmitter {
  private readonly workflows = new Map<string, Workflow>();
  private readonly runHistory: WorkflowRunResult[] = [];
  private readonly activeRuns = new Map<string, WorkflowRunResult>();
  private readonly cancelledRunIds = new Set<string>();
  private readonly MAX_HISTORY = 500;

  registerWorkflow(wf: Workflow): void {
    this.workflows.set(wf.id, wf);

    // Wire up event-based trigger
    if (wf.trigger.type === 'event' && wf.enabled) {
      const eventName = wf.trigger.config['event'] as string | undefined;
      if (eventName) {
        this.on(eventName, (data: unknown) => {
          this.trigger(wf.id, { _event: eventName, data }).catch((err) => {
            logger.error('Auto-trigger failed', { workflowId: wf.id, event: eventName, err });
          });
        });
        logger.debug('Workflow wired to event', { workflowId: wf.id, event: eventName });
      }
    }

    logger.info('Workflow registered', { id: wf.id, name: wf.name, trigger: wf.trigger.type });
  }

  async trigger(
    workflowId: string,
    input?: Record<string, unknown>,
  ): Promise<WorkflowRunResult> {
    const wf = this.workflows.get(workflowId);
    if (!wf) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (!wf.enabled) {
      throw new Error(`Workflow is disabled: ${workflowId}`);
    }

    const runId = randomUUID();
    const startedAt = new Date();
    logger.info('Workflow triggered', { runId, workflowId, name: wf.name });
    metrics.increment('workflow_runs_total', { workflowId });

    const run: WorkflowRunResult = {
      runId,
      workflowId,
      status: 'running',
      startedAt,
      success: false,
      stepResults: {},
      input,
    };

    this.activeRuns.set(runId, run);
    this.emit('workflow:started', run);
    await this.persistState(run);

    try {
      await this.executeWorkflow(wf, run, input ?? {});
      if (this.cancelledRunIds.has(runId)) {
        run.status = 'cancelled';
        run.success = false;
      } else {
        run.status = 'completed';
        run.success = true;
      }
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      run.success = false;
      run.status = this.cancelledRunIds.has(runId) ? 'cancelled' : 'failed';
      logger.warn('Workflow run failed', { runId, workflowId, error: run.error });
    }

    run.completedAt = new Date();
    metrics.histogram(
      'workflow_run_duration_ms',
      run.completedAt.getTime() - startedAt.getTime(),
      { workflowId },
    );
    metrics.increment('workflow_runs_completed_total', {
      workflowId,
      success: String(run.success),
    });

    this.activeRuns.delete(runId);
    this.cancelledRunIds.delete(runId);
    this.addToHistory(run);
    await this.persistState(run);

    if (run.status === 'cancelled') {
      this.emit('workflow:cancelled', run);
    }
    this.emit('workflow:complete', run);

    return run;
  }

  /**
   * Cancel an in-progress run by its runId (returned in the object passed to
   * the 'workflow:started' event, and as `.runId` on the eventual trigger()
   * result). The run stops before its NEXT step begins — an already-running
   * step is allowed to finish rather than being interrupted mid-flight, to
   * avoid leaving an external side effect (e.g. a partially-applied HTTP
   * call) in an undefined state.
   */
  async cancelWorkflow(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) {
      throw new Error(`No active run found for runId: ${runId}`);
    }
    this.cancelledRunIds.add(runId);
    logger.info('Workflow cancellation requested', { runId, workflowId: run.workflowId });
  }

  emit(event: string, data?: unknown): boolean {
    logger.debug('Workflow engine event', { event });
    return super.emit(event, data);
  }

  getRunHistory(): WorkflowRunResult[] {
    return [...this.runHistory];
  }

  getActiveRun(runId: string): WorkflowRunResult | undefined {
    return this.activeRuns.get(runId);
  }

  listWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /** Restore a previously-persisted run's state from runtime/workflows/<runId>.json. */
  async loadPersistedRun(runId: string): Promise<WorkflowRunResult | null> {
    try {
      const filePath = path.join(WORKFLOWS_STATE_DIR, `${runId}.json`);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as WorkflowRunResult;
      return {
        ...parsed,
        startedAt: new Date(parsed.startedAt),
        completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
      };
    } catch {
      return null;
    }
  }

  private async executeWorkflow(
    wf: Workflow,
    run: WorkflowRunResult,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (wf.steps.length === 0) return;

    let currentStepId: string | undefined = wf.steps[0]?.id;

    while (currentStepId) {
      if (this.cancelledRunIds.has(run.runId)) {
        logger.info('Workflow run cancelled before next step', {
          runId: run.runId,
          nextStep: currentStepId,
        });
        return;
      }

      const step = wf.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      const stepResult = await this.executeStepWithRetry(step, input, run);
      run.stepResults[step.id] = stepResult;
      await this.persistState(run);

      if (stepResult.success) {
        this.emit('workflow:step:complete', { runId: run.runId, step: stepResult });
        currentStepId = step.onSuccess ?? this.nextStepId(wf, step.id);
      } else {
        this.emit('workflow:step:failed', { runId: run.runId, step: stepResult });
        await this.writeToDlq(wf, run, step, stepResult);

        if (step.onFailure) {
          currentStepId = step.onFailure;
        } else {
          throw new Error(
            `Step ${step.id} (${step.name}) failed after ${stepResult.attempts} attempt(s): ${stepResult.error}`,
          );
        }
      }
    }
  }

  private async executeStepWithRetry(
    step: WorkflowStep,
    input: Record<string, unknown>,
    run: WorkflowRunResult,
  ): Promise<StepRunResult> {
    const policy = step.retryPolicy ?? DEFAULT_RETRY_POLICY;
    let attempt = 0;
    let lastError = '';

    while (attempt <= policy.maxRetries) {
      if (this.cancelledRunIds.has(run.runId)) {
        return { stepId: step.id, success: false, error: 'Cancelled', attempts: attempt };
      }

      attempt += 1;
      logger.debug('Executing workflow step', { stepId: step.id, action: step.action, attempt });

      try {
        const output = await this.dispatchAction(step.action, step.params ?? {});
        return { stepId: step.id, success: true, output, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn('Workflow step attempt failed', {
          stepId: step.id,
          action: step.action,
          attempt,
          error: lastError,
        });

        if (attempt <= policy.maxRetries) {
          const delay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    void input; // reserved for future step-to-step data passing
    return { stepId: step.id, success: false, error: lastError, attempts: attempt };
  }

  private nextStepId(wf: Workflow, currentId: string): string | undefined {
    const idx = wf.steps.findIndex((s) => s.id === currentId);
    if (idx < 0 || idx >= wf.steps.length - 1) return undefined;
    return wf.steps[idx + 1]?.id;
  }

  private async dispatchAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Extensible action dispatcher
    switch (action) {
      case 'log':
        logger.info('Workflow log action', { message: params['message'] });
        return { logged: true };

      case 'emit_event': {
        const eventName = params['event'] as string;
        if (!eventName) throw new Error('emit_event requires event param');
        this.emit(eventName, params['data']);
        return { emitted: eventName };
      }

      case 'http_request': {
        const url = params['url'] as string;
        if (!url) throw new Error('http_request requires url param');
        const axios = await import('axios');
        const method = (params['method'] as string) ?? 'GET';
        const resp = await axios.default.request({ url, method, data: params['body'] });
        return { status: resp.status, data: resp.data };
      }

      case 'sleep': {
        const ms = (params['ms'] as number) ?? 1000;
        await new Promise((r) => setTimeout(r, ms));
        return { slept: ms };
      }

      case 'noop':
        return { noop: true };

      default:
        // Emit custom action event and return
        this.emit(`action:${action}`, params);
        return { dispatched: action, params };
    }
  }

  private addToHistory(run: WorkflowRunResult): void {
    this.runHistory.push(run);
    if (this.runHistory.length > this.MAX_HISTORY) {
      this.runHistory.shift();
    }
  }

  /** Best-effort persistence — failures here never fail the workflow run itself. */
  private async persistState(run: WorkflowRunResult): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') return;
    try {
      await mkdir(WORKFLOWS_STATE_DIR, { recursive: true });
      const filePath = path.join(WORKFLOWS_STATE_DIR, `${run.runId}.json`);
      await writeFile(filePath, JSON.stringify(run, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to persist workflow state', {
        runId: run.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Best-effort DLQ write — failures here never fail the workflow run itself. */
  private async writeToDlq(
    wf: Workflow,
    run: WorkflowRunResult,
    step: WorkflowStep,
    stepResult: StepRunResult,
  ): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') return;
    try {
      await mkdir(RUNTIME_DIR, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        runId: run.runId,
        workflowId: wf.id,
        stepId: step.id,
        stepName: step.name,
        action: step.action,
        attempts: stepResult.attempts,
        error: stepResult.error,
      };
      await appendFile(DLQ_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      logger.warn('Failed to write to workflow DLQ', {
        runId: run.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const workflowEngine = new WorkflowEngine();
