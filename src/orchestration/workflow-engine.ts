import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('workflow-engine');

const RUNTIME_DIR = join(process.cwd(), 'runtime');
const WORKFLOWS_DIR = join(RUNTIME_DIR, 'workflows');
const DLQ_PATH = join(RUNTIME_DIR, 'workflow-dlq.jsonl');

export interface WorkflowTrigger {
  type: 'manual' | 'schedule' | 'event' | 'label';
  config: Record<string, unknown>;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

export interface DlqEntry {
  workflowId: string;
  stepId: string;
  error: string;
  attempts: number;
  lastAttemptAt: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  action: string;
  params?: Record<string, unknown>;
  onSuccess?: string;
  onFailure?: string;
  retryPolicy?: RetryPolicy;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
}

export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
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
  attempts?: number;
}

export class WorkflowEngine extends EventEmitter {
  private readonly workflows = new Map<string, Workflow>();
  private readonly runHistory: WorkflowRunResult[] = [];
  private readonly cancelledRuns = new Set<string>();
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
      startedAt,
      success: false,
      stepResults: {},
      ...(input !== undefined ? { input } : {}),
    };

    this.emit('workflow:started', { runId, workflowId });

    try {
      await this.executeWorkflow(wf, run, input ?? {});

      if (this.cancelledRuns.has(runId)) {
        run.success = false;
        run.error = 'Workflow was cancelled';
        this.emit('workflow:cancelled', { runId, workflowId });
      } else {
        run.success = true;
        this.emit('workflow:complete', run);
      }
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      run.success = false;
      logger.warn('Workflow run failed', { runId, workflowId, error: run.error });

      if (this.cancelledRuns.has(runId)) {
        this.emit('workflow:cancelled', { runId, workflowId });
      } else {
        this.emit('workflow:complete', run);
      }
    } finally {
      this.cancelledRuns.delete(runId);
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

    this.addToHistory(run);
    this.persistState(run);
    return run;
  }

  async cancelWorkflow(runId: string): Promise<void> {
    this.cancelledRuns.add(runId);
    logger.info('Workflow cancellation requested', { runId });
  }

  override emit(event: string, data?: unknown): boolean {
    logger.debug('Workflow engine event', { event });
    return super.emit(event, data);
  }

  getRunHistory(): WorkflowRunResult[] {
    return [...this.runHistory];
  }

  listWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  private async executeWorkflow(
    wf: Workflow,
    run: WorkflowRunResult,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (wf.steps.length === 0) return;

    let currentStepId: string | undefined = wf.steps[0]?.id;

    while (currentStepId) {
      if (this.cancelledRuns.has(run.runId)) {
        logger.info('Workflow execution halted due to cancellation', {
          runId: run.runId,
          workflowId: run.workflowId,
        });
        return;
      }

      const step = wf.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      const stepResult = await this.executeStep(step, input, run.stepResults, run);
      run.stepResults[step.id] = stepResult;

      if (stepResult.success) {
        this.emit('workflow:step:complete', { runId: run.runId, workflowId: run.workflowId, stepId: step.id, output: stepResult.output });
        currentStepId = step.onSuccess ?? this.nextStepId(wf, step.id);
      } else {
        this.emit('workflow:step:failed', { runId: run.runId, workflowId: run.workflowId, stepId: step.id, error: stepResult.error });
        if (step.onFailure) {
          currentStepId = step.onFailure;
        } else {
          throw new Error(`Step ${step.id} (${step.name}) failed: ${stepResult.error}`);
        }
      }
    }
  }

  private nextStepId(wf: Workflow, currentId: string): string | undefined {
    const idx = wf.steps.findIndex((s) => s.id === currentId);
    if (idx < 0 || idx >= wf.steps.length - 1) return undefined;
    return wf.steps[idx + 1]?.id;
  }

  private async executeStep(
    step: WorkflowStep,
    _input: Record<string, unknown>,
    _prevResults: Record<string, StepRunResult>,
    run: WorkflowRunResult,
  ): Promise<StepRunResult> {
    logger.debug('Executing workflow step', { stepId: step.id, action: step.action });

    const policy = step.retryPolicy;
    const maxRetries = policy?.maxRetries ?? 0;
    const initialDelayMs = policy?.initialDelayMs ?? 1000;
    const backoffMultiplier = policy?.backoffMultiplier ?? 2;
    const maxDelayMs = policy?.maxDelayMs ?? 30_000;

    let attempt = 0;
    let lastError = '';

    while (attempt <= maxRetries) {
      try {
        const output = await this.dispatchAction(step.action, step.params ?? {});
        return { stepId: step.id, success: true, output, attempts: attempt + 1 };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn('Workflow step attempt failed', {
          stepId: step.id,
          action: step.action,
          attempt: attempt + 1,
          maxRetries,
          error: lastError,
        });
        attempt++;

        if (attempt <= maxRetries) {
          const delay = Math.min(
            initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
            maxDelayMs,
          );
          logger.debug('Retrying workflow step after delay', { stepId: step.id, delayMs: delay, attempt });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted — write to DLQ
    const dlqEntry: DlqEntry = {
      workflowId: run.workflowId,
      stepId: step.id,
      error: lastError,
      attempts: attempt,
      lastAttemptAt: new Date().toISOString(),
    };
    this.writeDlqEntry(dlqEntry);

    return { stepId: step.id, success: false, error: lastError, attempts: attempt };
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

  private persistState(run: WorkflowRunResult): void {
    try {
      mkdirSync(WORKFLOWS_DIR, { recursive: true });
      const filePath = join(WORKFLOWS_DIR, `${run.workflowId}.json`);
      writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to persist workflow state', { workflowId: run.workflowId, err });
    }
  }

  private writeDlqEntry(entry: DlqEntry): void {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      appendFileSync(DLQ_PATH, JSON.stringify(entry) + '\n', 'utf8');
      logger.warn('Workflow step written to DLQ', entry);
    } catch (err) {
      logger.error('Failed to write to DLQ', { entry, err });
    }
  }

  private addToHistory(run: WorkflowRunResult): void {
    this.runHistory.push(run);
    if (this.runHistory.length > this.MAX_HISTORY) {
      this.runHistory.shift();
    }
  }
}

export const workflowEngine = new WorkflowEngine();
