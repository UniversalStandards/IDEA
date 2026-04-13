import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { appendFile, writeFile, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('workflow-engine');

// Runtime directories for state persistence and DLQ
const RUNTIME_DIR = join(process.cwd(), 'runtime');
const WORKFLOWS_DIR = join(RUNTIME_DIR, 'workflows');
const DLQ_PATH = join(RUNTIME_DIR, 'workflow-dlq.jsonl');

// Ensure runtime directories exist at module load time
try {
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
} catch {
  // Non-fatal — runtime dir creation failure is logged at first use
}

/** Internal error class for cancelled runs */
class WorkflowCancelledError extends Error {
  constructor(runId: string) {
    super(`Workflow run cancelled: ${runId}`);
    this.name = 'WorkflowCancelledError';
  }
}

export interface WorkflowTrigger {
  type: 'manual' | 'schedule' | 'event' | 'label';
  config: Record<string, unknown>;
}

export interface WorkflowStep {
  id: string;
  name: string;
  action: string;
  params?: Record<string, unknown>;
  onSuccess?: string;
  onFailure?: string;
  /** Maximum retry attempts for this step (overrides workflow-level default) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (overrides workflow-level default) */
  initialDelayMs?: number;
  /** Multiplier applied to delay on each subsequent retry (overrides workflow-level default) */
  backoffMultiplier?: number;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  /** Global default maximum retry attempts for all steps */
  maxRetries?: number;
  /** Global default initial retry delay in ms */
  initialDelayMs?: number;
  /** Global default backoff multiplier */
  backoffMultiplier?: number;
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
}

/** DLQ record written to workflow-dlq.jsonl for permanently failed runs */
interface DlqEntry {
  runId: string;
  workflowId: string;
  workflowName: string;
  failedAt: string;
  error: string;
  stepResults: Record<string, StepRunResult>;
}

export class WorkflowEngine extends EventEmitter {
  private readonly workflows = new Map<string, Workflow>();
  private readonly runHistory: WorkflowRunResult[] = [];
  private readonly MAX_HISTORY = 500;
  /** Set of runIds that have been cancelled */
  private readonly cancelledRuns = new Set<string>();

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
      input,
    };

    this.emit('workflow:started', { runId, workflowId });

    let cancelled = false;
    try {
      await this.executeWorkflow(wf, run, input ?? {});
      run.success = true;
    } catch (err) {
      if (err instanceof WorkflowCancelledError) {
        cancelled = true;
        run.error = err.message;
        run.success = false;
        logger.info('Workflow run cancelled', { runId, workflowId });
      } else {
        run.error = err instanceof Error ? err.message : String(err);
        run.success = false;
        logger.warn('Workflow run failed', { runId, workflowId, error: run.error });
        // Write to DLQ for permanently failed runs
        await this.writeToDlq(wf, run);
      }
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

    // Clean up persisted state file on success
    if (run.success) {
      await this.deleteStateFile(run.runId);
    }

    this.addToHistory(run);

    // Emit both new and legacy event names for back-compat
    this.emit('workflow:complete', run);
    this.emit('workflow:completed', run);

    if (cancelled) {
      this.emit('workflow:cancelled', { runId, workflowId });
      this.cancelledRuns.delete(runId);
    }

    return run;
  }

  /**
   * Cancel an in-progress workflow run by its runId.
   * The run will stop at the next step boundary.
   */
  async cancelWorkflow(runId: string): Promise<void> {
    this.cancelledRuns.add(runId);
    logger.info('Workflow cancellation requested', { runId });
  }

  emit(event: string, data?: unknown): boolean {
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
      // Check for cancellation before each step
      if (this.cancelledRuns.has(run.runId)) {
        throw new WorkflowCancelledError(run.runId);
      }

      const step = wf.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      const stepResult = await this.executeStepWithRetry(step, wf, input, run);
      run.stepResults[step.id] = stepResult;

      // Persist state after each step
      await this.persistState(run);

      if (stepResult.success) {
        this.emit('workflow:step:complete', {
          runId: run.runId,
          stepId: step.id,
          output: stepResult.output,
        });
        currentStepId = step.onSuccess ?? this.nextStepId(wf, step.id);
      } else {
        if (step.onFailure) {
          currentStepId = step.onFailure;
        } else {
          throw new Error(`Step ${step.id} (${step.name}) failed: ${stepResult.error}`);
        }
      }
    }
  }

  private async executeStepWithRetry(
    step: WorkflowStep,
    wf: Workflow,
    input: Record<string, unknown>,
    run: WorkflowRunResult,
  ): Promise<StepRunResult> {
    const maxRetries = step.maxRetries ?? wf.maxRetries ?? 0;
    const initialDelayMs = step.initialDelayMs ?? wf.initialDelayMs ?? 1000;
    const backoffMultiplier = step.backoffMultiplier ?? wf.backoffMultiplier ?? 2;

    let delayMs = initialDelayMs;
    // Execute first attempt outside the retry loop so result is always defined
    const totalAttempts = maxRetries + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      // Check for cancellation before each attempt
      if (this.cancelledRuns.has(run.runId)) {
        throw new WorkflowCancelledError(run.runId);
      }

      const result = await this.executeStep(step, input, run.stepResults);

      if (result.success) {
        return result;
      }

      this.emit('workflow:step:failed', {
        runId: run.runId,
        stepId: step.id,
        error: result.error,
        attempt,
      });

      const isLastAttempt = attempt === totalAttempts - 1;
      if (!isLastAttempt) {
        logger.debug('Retrying workflow step', {
          stepId: step.id,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
        });
        await this.sleep(delayMs);
        delayMs = Math.round(delayMs * backoffMultiplier);
      } else {
        return result;
      }
    }

    // Unreachable: totalAttempts >= 1 always, loop always returns or throws
    return { stepId: step.id, success: false, error: 'Step execution produced no result' };
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
  ): Promise<StepRunResult> {
    logger.debug('Executing workflow step', { stepId: step.id, action: step.action });

    try {
      const output = await this.dispatchAction(step.action, step.params ?? {});
      return { stepId: step.id, success: true, output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('Workflow step failed', { stepId: step.id, action: step.action, error });
      return { stepId: step.id, success: false, error };
    }
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
        await this.sleep(ms);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async persistState(run: WorkflowRunResult): Promise<void> {
    try {
      const statePath = join(WORKFLOWS_DIR, `${run.runId}.json`);
      const serializable = {
        ...run,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString(),
      };
      await writeFile(statePath, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to persist workflow state', { runId: run.runId, err });
    }
  }

  private async deleteStateFile(runId: string): Promise<void> {
    try {
      const statePath = join(WORKFLOWS_DIR, `${runId}.json`);
      await unlink(statePath);
    } catch {
      // File may not exist; non-fatal
    }
  }

  private async writeToDlq(wf: Workflow, run: WorkflowRunResult): Promise<void> {
    try {
      const entry: DlqEntry = {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowName: wf.name,
        failedAt: new Date().toISOString(),
        error: run.error ?? 'unknown error',
        stepResults: run.stepResults,
      };
      await appendFile(DLQ_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch (dlqErr) {
      logger.error('Failed to write to DLQ', { runId: run.runId, dlqErr });
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
