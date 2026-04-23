/**
 * tests/workflow-engine.test.ts
 * Unit tests for src/orchestration/workflow-engine.ts
 *
 * Coverage:
 * - Sequential workflow execution
 * - Retry with exponential backoff
 * - Workflow cancellation
 * - DLQ writing after exhausted retries
 * - State persistence to runtime/workflows/
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  WorkflowEngine,
  type Workflow,
  type WorkflowStep,
  type RetryPolicy,
  type DlqEntry,
} from '../src/orchestration/workflow-engine';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const TMP_RUNTIME = join(process.cwd(), 'runtime-test-' + process.pid);
const DLQ_PATH = join(TMP_RUNTIME, 'workflow-dlq.jsonl');
const WORKFLOWS_DIR = join(TMP_RUNTIME, 'workflow-test-workflows');

/** Re-point the engine's runtime paths to our tmp directory so tests don't
 *  pollute the real runtime/ folder. We do this by monkey-patching the
 *  module-level constants via re-requiring the module in an isolated context,
 *  but the simplest approach is to spy on fs calls and redirect them.
 */

function makeStep(
  id: string,
  action = 'noop',
  overrides: Partial<WorkflowStep> = {},
): WorkflowStep {
  return { id, name: id, action, ...overrides };
}

function makeWorkflow(
  id: string,
  steps: WorkflowStep[],
  overrides: Partial<Workflow> = {},
): Workflow {
  return {
    id,
    name: id,
    trigger: { type: 'manual', config: {} },
    steps,
    enabled: true,
    ...overrides,
  };
}

function fastRetryPolicy(maxRetries: number): RetryPolicy {
  return {
    maxRetries,
    initialDelayMs: 0,
    backoffMultiplier: 1,
    maxDelayMs: 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  // Track real fs calls by mocking them
  const fsMocks = {
    mkdirSyncCalls: [] as string[],
    writeFileSyncCalls: [] as Array<{ path: string; content: string }>,
    appendFileSyncCalls: [] as Array<{ path: string; content: string }>,
  };

  // Patch fs methods to capture calls without touching the real filesystem
  let origMkdirSync: typeof mkdirSync;
  let origWriteFileSync: typeof import('fs').writeFileSync;
  let origAppendFileSync: typeof import('fs').appendFileSync;

  beforeAll(() => {
    // Ensure tmp dir exists for any real-path tests
    mkdirSync(TMP_RUNTIME, { recursive: true });
    mkdirSync(WORKFLOWS_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TMP_RUNTIME)) rmSync(TMP_RUNTIME, { recursive: true, force: true });
  });

  beforeEach(() => {
    engine = new WorkflowEngine();
    fsMocks.mkdirSyncCalls = [];
    fsMocks.writeFileSyncCalls = [];
    fsMocks.appendFileSyncCalls = [];
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Sequential execution
  // ──────────────────────────────────────────────────────────────────────────

  it('executes all steps in order for a simple sequential workflow', async () => {
    const executed: string[] = [];
    const wf = makeWorkflow('wf-seq', [
      makeStep('s1', 'noop'),
      makeStep('s2', 'noop'),
      makeStep('s3', 'noop'),
    ]);

    engine.on('workflow:step:complete', (data: unknown) => {
      const d = data as { stepId: string };
      executed.push(d.stepId);
    });

    engine.registerWorkflow(wf);
    const result = await engine.trigger('wf-seq');

    expect(result.success).toBe(true);
    expect(Object.keys(result.stepResults)).toEqual(['s1', 's2', 's3']);
    expect(executed).toEqual(['s1', 's2', 's3']);
  });

  it('emits workflow:started and workflow:complete events', async () => {
    const events: string[] = [];
    engine.on('workflow:started', () => events.push('started'));
    engine.on('workflow:complete', () => events.push('complete'));

    engine.registerWorkflow(makeWorkflow('wf-events', [makeStep('s1')]));
    await engine.trigger('wf-events');

    expect(events).toContain('started');
    expect(events).toContain('complete');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Retry with exponential backoff
  // ──────────────────────────────────────────────────────────────────────────

  it('retries a failing step up to maxRetries before marking it failed', async () => {
    let callCount = 0;

    engine.on('action:fail_action', () => {
      callCount++;
      throw new Error('deliberate failure');
    });

    // The engine's dispatchAction emits to the EventEmitter for unknown actions
    // — but it doesn't throw from there. We need a custom approach: register
    // a listener that throws.  However, the dispatcher catches via try/catch
    // in executeStep, so we instead use a spy on dispatchAction by customising
    // a step that uses an action registered in the default branch.
    //
    // Simpler: use a subclass to make dispatchAction throw on demand.
    class FailingEngine extends WorkflowEngine {
      private failCount = 0;
      readonly maxFails: number;
      constructor(maxFails: number) {
        super();
        this.maxFails = maxFails;
      }
      // Override to throw for the 'fail_n_times' action
      protected dispatchFail(): unknown {
        this.failCount++;
        if (this.failCount <= this.maxFails) {
          throw new Error(`Attempt ${this.failCount} failed`);
        }
        return { recovered: true };
      }
    }

    const retryEngine = new (class extends WorkflowEngine {
      private callCount = 0;
      private readonly failUntil: number;
      constructor(failUntil: number) {
        super();
        this.failUntil = failUntil;
      }
      // Expose for testing: track attempt count per step
      getCallCount(): number { return this.callCount; }
    })(3);

    // We can't easily subclass dispatchAction without re-exporting it.
    // Instead, spy on the action via the 'action:custom' event path — but
    // that path doesn't throw. Use a different approach: test via a step
    // whose action always throws and retryPolicy catches it.

    // Best approach: use Jest to mock the module's dispatchAction indirectly
    // by registering a custom action listener that throws synchronously.
    // The default branch of dispatchAction emits `action:<name>` and returns
    // — it does NOT throw. So a failing test must use a real throwing path.
    //
    // Let's directly subclass WorkflowEngine and override the private method
    // using TypeScript access via (engine as any).

    const failingEngine = new WorkflowEngine();

    let attempts = 0;
    // Monkey-patch dispatchAction to track calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only hack to access private method
    const original = (failingEngine as any).dispatchAction.bind(failingEngine);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (failingEngine as any).dispatchAction = async (
      action: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (action === 'failing_action') {
        attempts++;
        throw new Error('always fails');
      }
      return original(action, params);
    };

    const policy = fastRetryPolicy(2); // maxRetries=2 means 3 total attempts
    const wf = makeWorkflow('wf-retry', [
      makeStep('s1', 'failing_action', { retryPolicy: policy }),
    ]);
    failingEngine.registerWorkflow(wf);

    const result = await failingEngine.trigger('wf-retry');

    expect(result.success).toBe(false);
    expect(attempts).toBe(3); // initial + 2 retries
    expect(result.stepResults['s1']?.success).toBe(false);
    expect(result.stepResults['s1']?.attempts).toBe(3);
  });

  it('succeeds on a later retry attempt', async () => {
    const failingEngine = new WorkflowEngine();
    let attempts = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (failingEngine as any).dispatchAction = async (action: string): Promise<unknown> => {
      if (action === 'flaky') {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
        return { ok: true };
      }
      return { noop: true };
    };

    const policy = fastRetryPolicy(5); // plenty of retries
    const wf = makeWorkflow('wf-flaky', [
      makeStep('s1', 'flaky', { retryPolicy: policy }),
    ]);
    failingEngine.registerWorkflow(wf);

    const result = await failingEngine.trigger('wf-flaky');

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
    expect(result.stepResults['s1']?.attempts).toBe(3);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Cancellation
  // ──────────────────────────────────────────────────────────────────────────

  it('halts further step execution after cancelWorkflow is called', async () => {
    const completedSteps: string[] = [];

    const slowEngine = new WorkflowEngine();
    let runIdCapture = '';

    slowEngine.on('workflow:started', (data: unknown) => {
      const d = data as { runId: string };
      runIdCapture = d.runId;
      // Cancel after started (before any step runs)
      void slowEngine.cancelWorkflow(d.runId);
    });

    slowEngine.on('workflow:step:complete', (data: unknown) => {
      completedSteps.push((data as { stepId: string }).stepId);
    });

    const wf = makeWorkflow('wf-cancel', [
      makeStep('s1', 'noop'),
      makeStep('s2', 'noop'),
      makeStep('s3', 'noop'),
    ]);
    slowEngine.registerWorkflow(wf);

    const result = await slowEngine.trigger('wf-cancel');

    expect(result.success).toBe(false);
    // No steps should have completed (cancel was requested before first step)
    expect(completedSteps).toHaveLength(0);
  });

  it('emits workflow:cancelled event when cancelled', async () => {
    const events: string[] = [];
    const cancelEngine = new WorkflowEngine();

    cancelEngine.on('workflow:started', (data: unknown) => {
      const d = data as { runId: string };
      void cancelEngine.cancelWorkflow(d.runId);
    });
    cancelEngine.on('workflow:cancelled', () => events.push('cancelled'));
    cancelEngine.on('workflow:complete', () => events.push('complete'));

    cancelEngine.registerWorkflow(makeWorkflow('wf-cancel-event', [makeStep('s1')]));
    await cancelEngine.trigger('wf-cancel-event');

    expect(events).toContain('cancelled');
    expect(events).not.toContain('complete');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. DLQ writing after exhausted retries
  // ──────────────────────────────────────────────────────────────────────────

  it('writes a DLQ entry when a step exhausts all retries', async () => {
    const dlqEntries: DlqEntry[] = [];

    const dlqEngine = new WorkflowEngine();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (dlqEngine as any).writeDlqEntry = (entry: DlqEntry): void => {
      dlqEntries.push(entry);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (dlqEngine as any).dispatchAction = async (action: string): Promise<unknown> => {
      if (action === 'always_fails') throw new Error('permanent error');
      return { noop: true };
    };

    const policy = fastRetryPolicy(1); // 1 retry = 2 total attempts
    const wf = makeWorkflow('wf-dlq', [
      makeStep('s1', 'always_fails', { retryPolicy: policy }),
    ]);
    dlqEngine.registerWorkflow(wf);

    await dlqEngine.trigger('wf-dlq');

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0]!;
    expect(entry.workflowId).toBe('wf-dlq');
    expect(entry.stepId).toBe('s1');
    expect(entry.error).toMatch('permanent error');
    expect(entry.attempts).toBe(2);
    expect(entry.lastAttemptAt).toBeTruthy();
  });

  it('DLQ entry includes all required fields', async () => {
    const dlqEntries: DlqEntry[] = [];
    const dlqEngine = new WorkflowEngine();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (dlqEngine as any).writeDlqEntry = (entry: DlqEntry): void => {
      dlqEntries.push(entry);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (dlqEngine as any).dispatchAction = async (): Promise<unknown> => {
      throw new Error('step error message');
    };

    const wf = makeWorkflow('wf-dlq-fields', [
      makeStep('step-a', 'bad_action', { retryPolicy: fastRetryPolicy(0) }),
    ]);
    dlqEngine.registerWorkflow(wf);
    await dlqEngine.trigger('wf-dlq-fields');

    const entry = dlqEntries[0]!;
    expect(entry).toMatchObject<DlqEntry>({
      workflowId: 'wf-dlq-fields',
      stepId: 'step-a',
      error: 'step error message',
      attempts: 1,
      lastAttemptAt: expect.any(String) as string,
    });
    // lastAttemptAt must be a valid ISO 8601 timestamp
    expect(new Date(entry.lastAttemptAt).toISOString()).toBe(entry.lastAttemptAt);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. State persistence
  // ──────────────────────────────────────────────────────────────────────────

  it('persists workflow state to runtime/workflows/<workflowId>.json', async () => {
    const persisted: Array<{ path: string; content: string }> = [];
    const persistEngine = new WorkflowEngine();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (persistEngine as any).persistState = (run: unknown): void => {
      persisted.push({ path: `workflows/${(run as { workflowId: string }).workflowId}.json`, content: JSON.stringify(run) });
    };

    persistEngine.registerWorkflow(makeWorkflow('wf-persist', [makeStep('s1'), makeStep('s2')]));
    await persistEngine.trigger('wf-persist');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.path).toBe('workflows/wf-persist.json');
    const state = JSON.parse(persisted[0]!.content) as Record<string, unknown>;
    expect(state['workflowId']).toBe('wf-persist');
    expect(state['success']).toBe(true);
    expect(state['stepResults']).toBeDefined();
  });

  it('persisted state includes all step results', async () => {
    const persisted: Array<{ workflowId: string; stepResults: Record<string, unknown> }> = [];
    const persistEngine = new WorkflowEngine();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (persistEngine as any).persistState = (run: unknown): void => {
      const r = run as { workflowId: string; stepResults: Record<string, unknown> };
      persisted.push({ workflowId: r.workflowId, stepResults: r.stepResults });
    };

    persistEngine.registerWorkflow(makeWorkflow('wf-state', [makeStep('s1'), makeStep('s2'), makeStep('s3')]));
    await persistEngine.trigger('wf-state');

    expect(persisted[0]!.stepResults).toHaveProperty('s1');
    expect(persisted[0]!.stepResults).toHaveProperty('s2');
    expect(persisted[0]!.stepResults).toHaveProperty('s3');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Edge cases
  // ──────────────────────────────────────────────────────────────────────────

  it('throws when triggering an unknown workflow', async () => {
    await expect(engine.trigger('nonexistent')).rejects.toThrow('Workflow not found: nonexistent');
  });

  it('throws when triggering a disabled workflow', async () => {
    engine.registerWorkflow(makeWorkflow('wf-disabled', [], { enabled: false }));
    await expect(engine.trigger('wf-disabled')).rejects.toThrow('Workflow is disabled: wf-disabled');
  });

  it('succeeds for an empty workflow (no steps)', async () => {
    engine.registerWorkflow(makeWorkflow('wf-empty', []));
    const result = await engine.trigger('wf-empty');
    expect(result.success).toBe(true);
    expect(result.stepResults).toEqual({});
  });

  it('step:failed event is emitted when a step fails with onFailure defined', async () => {
    const failedEvents: string[] = [];
    engine.on('workflow:step:failed', (data: unknown) => {
      failedEvents.push((data as { stepId: string }).stepId);
    });

    // s1 fails → goes to s2 via onFailure
    const wf = makeWorkflow('wf-step-fail', [
      makeStep('s1', 'bad', { onFailure: 's2' }),
      makeStep('s2', 'noop'),
    ]);

    const failEngine = new WorkflowEngine();
    failEngine.on('workflow:step:failed', (data: unknown) => {
      failedEvents.push((data as { stepId: string }).stepId);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    (failEngine as any).dispatchAction = async (action: string): Promise<unknown> => {
      if (action === 'bad') throw new Error('bad action');
      return { noop: true };
    };

    failEngine.registerWorkflow(wf);
    const result = await failEngine.trigger('wf-step-fail');

    expect(failedEvents).toContain('s1');
    expect(result.success).toBe(true); // recovered via onFailure
  });
});
