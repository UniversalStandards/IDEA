import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('workflow-engine');

const RUNTIME_DIR = path.join(process.cwd(), 'runtime');
const WORKFLOWS_DIR = path.join(RUNTIME_DIR, 'workflows');
const DLQ_FILE = path.join(RUNTIME_DIR, 'workflow-dlq.jsonl');

/**
 * Sanitizes a workflow ID so it is safe to use as a file-name component.
 * Only alphanumeric characters, hyphens, underscores, and dots are permitted.
 * `path.basename` strips any remaining path separators, and the final resolved
 * path is verified to remain inside WORKFLOWS_DIR to prevent path traversal.
 */
function safeWorkflowPath(workflowId: string): string {
  // Strip all non-safe characters first, then extract just the basename to
  // ensure no directory traversal components remain.
  const sanitized = path.basename(workflowId.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid workflowId: ${workflowId}`);
  }
  const resolved = path.resolve(WORKFLOWS_DIR, `${sanitized}.json`);
  // Verify the resolved path is strictly inside the workflows directory.
  if (!resolved.startsWith(WORKFLOWS_DIR + path.sep)) {
    throw new Error(`Invalid workflowId (path escape detected): ${workflowId}`);
  }
  return resolved;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
};

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
  retry?: Partial<RetryConfig>;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  retry?: Partial<RetryConfig>;
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
  cancelled?: boolean;
}

export interface StepRunResult {
  stepId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  attempts?: number;
}

/** Marker error used internally to propagate cancellation through the call stack. */
class WorkflowCancelledError extends Error {
  constructor(workflowId: string) {
    super(`Workflow cancelled: ${workflowId}`);
    this.name = 'WorkflowCancelledError';
  }
}

export class WorkflowEngine extends EventEmitter {
  private readonly workflows = new Map<string, Workflow>();
  private readonly runHistory: WorkflowRunResult[] = [];
  private readonly MAX_HISTORY = 500;
  /** Set of workflowIds for which cancellation has been requested. */
  private readonly cancelledWorkflows = new Set<string>();

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
      ...(input !== undefined && { input }),
    };

    this.emit('workflow:started', { runId, workflowId });
    this.persistState(run);

    try {
      await this.executeWorkflow(wf, run, input ?? {});
      run.success = true;
    } catch (err) {
      if (err instanceof WorkflowCancelledError) {
        run.cancelled = true;
        run.error = err.message;
        logger.info('Workflow run cancelled', { runId, workflowId });
      } else {
        run.error = err instanceof Error ? err.message : String(err);
        run.success = false;
        logger.warn('Workflow run failed', { runId, workflowId, error: run.error });
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

    this.clearPersistedState(workflowId);
    this.addToHistory(run);

    if (run.cancelled) {
      this.emit('workflow:cancelled', run);
    } else {
      this.emit('workflow:complete', run);
    }

    return run;
  }

  /**
   * Request cancellation of any in-progress (or future) run for the given workflowId.
   * The cancellation is checked between steps, so the current step completes before stopping.
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    if (!this.workflows.has(workflowId)) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    logger.info('Workflow cancellation requested', { workflowId });
    this.cancelledWorkflows.add(workflowId);
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
      // Check for cancellation before executing each step
      if (this.cancelledWorkflows.has(wf.id)) {
        this.cancelledWorkflows.delete(wf.id);
        throw new WorkflowCancelledError(wf.id);
      }

      const step = wf.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      // Merge retry config: step-level overrides workflow-level overrides default
      const retryConfig: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        ...wf.retry,
        ...step.retry,
      };

      const stepResult = await this.executeStepWithRetry(step, input, run.stepResults, retryConfig, wf.id);
      run.stepResults[step.id] = stepResult;
      this.persistState(run);

      if (stepResult.success) {
        this.emit('workflow:step:complete', { runId: run.runId, workflowId: wf.id, step: step.id, result: stepResult });
        currentStepId = step.onSuccess ?? this.nextStepId(wf, step.id);
      } else {
        this.emit('workflow:step:failed', { runId: run.runId, workflowId: wf.id, step: step.id, result: stepResult });
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

  /**
   * Execute a single step with exponential-backoff retry.
   * On permanent failure (all retries exhausted), the failed entry is written to the DLQ.
   */
  private async executeStepWithRetry(
    step: WorkflowStep,
    input: Record<string, unknown>,
    prevResults: Record<string, StepRunResult>,
    retryConfig: RetryConfig,
    workflowId: string,
  ): Promise<StepRunResult> {
    const { maxRetries, initialDelayMs, backoffMultiplier } = retryConfig;
    let lastError = '';
    let delayMs = initialDelayMs;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const result = await this.executeStep(step, input, prevResults);
      if (result.success) {
        return { ...result, attempts: attempt };
      }

      lastError = result.error ?? 'unknown error';

      if (attempt <= maxRetries) {
        logger.warn('Workflow step failed, retrying', {
          stepId: step.id,
          attempt,
          maxRetries,
          delayMs,
          error: lastError,
        });
        await this.sleep(delayMs);
        delayMs = Math.round(delayMs * backoffMultiplier);
      }
    }

    // All retries exhausted — write to DLQ
    const dlqEntry = {
      timestamp: new Date().toISOString(),
      workflowId,
      stepId: step.id,
      stepName: step.name,
      action: step.action,
      params: step.params ?? {},
      error: lastError,
      attempts: maxRetries + 1,
    };
    this.writeToDlq(dlqEntry);

    return { stepId: step.id, success: false, error: lastError, attempts: maxRetries + 1 };
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

  /** Sleeps for the given number of milliseconds. Extracted for testability. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Appends a failed-step entry to the dead-letter queue file. */
  private writeToDlq(entry: Record<string, unknown>): void {
    try {
      this.ensureRuntimeDirs();
      fs.appendFileSync(DLQ_FILE, JSON.stringify(entry) + '\n', 'utf8');
      logger.warn('Step written to DLQ', { stepId: entry['stepId'], workflowId: entry['workflowId'] });
    } catch (err) {
      logger.error('Failed to write to DLQ', { err });
    }
  }

  /** Persists the current workflow run state to disk for crash recovery. */
  private persistState(run: WorkflowRunResult): void {
    try {
      this.ensureRuntimeDirs();
      const filePath = safeWorkflowPath(run.workflowId);
      const data = JSON.stringify({ ...run, startedAt: run.startedAt.toISOString() }, null, 2);
      fs.writeFileSync(filePath, data, 'utf8');
    } catch (err) {
      logger.error('Failed to persist workflow state', { workflowId: run.workflowId, err });
    }
  }

  /** Removes the persisted state file for a workflow on completion or failure. */
  private clearPersistedState(workflowId: string): void {
    try {
      const filePath = safeWorkflowPath(workflowId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.error('Failed to clear persisted workflow state', { workflowId, err });
    }
  }

  /**
   * Loads a previously persisted workflow run state from disk.
   * Returns null if no state file exists for the given workflowId.
   */
  loadPersistedState(workflowId: string): WorkflowRunResult | null {
    try {
      const filePath = safeWorkflowPath(workflowId);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as WorkflowRunResult & { startedAt: string };
      return { ...parsed, startedAt: new Date(parsed.startedAt) };
    } catch (err) {
      logger.error('Failed to load persisted workflow state', { workflowId, err });
      return null;
    }
  }

  /** Ensures runtime directories exist, creating them if necessary. */
  private ensureRuntimeDirs(): void {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
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
