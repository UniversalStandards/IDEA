/**
 * tests/workflow-engine.test.ts
 * Unit tests for src/orchestration/workflow-engine.ts
 *
 * Covers: retry with exponential backoff, DLQ, state persistence,
 * workflow cancellation, and event emission.
 */

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
  },
}));

import * as fs from 'fs';
import { WorkflowEngine, Workflow, WorkflowRunResult } from '../src/orchestration/workflow-engine';

/** Build a minimal workflow for tests. */
function makeWorkflow(
  overrides: Partial<Workflow> & { steps?: Workflow['steps'] } = {},
): Workflow {
  return {
    id: 'wf-test',
    name: 'Test Workflow',
    trigger: { type: 'manual', config: {} },
    enabled: true,
    steps: [
      { id: 'step-1', name: 'Step 1', action: 'noop' },
      { id: 'step-2', name: 'Step 2', action: 'noop' },
    ],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = any;

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  const fsMock = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    jest.clearAllMocks();
    fsMock.existsSync.mockReturnValue(false);
    engine = new WorkflowEngine();
  });

  // ────────────────────────────────────────────────────────
  // Sequential execution
  // ────────────────────────────────────────────────────────

  it('executes all steps in order for a simple sequential workflow', async () => {
    const order: string[] = [];
    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    dispatchSpy
      .mockImplementationOnce(async () => { order.push('step-1'); return { noop: true }; })
      .mockImplementationOnce(async () => { order.push('step-2'); return { noop: true }; });

    engine.registerWorkflow(makeWorkflow());
    const run = await engine.trigger('wf-test');

    expect(run.success).toBe(true);
    expect(order).toEqual(['step-1', 'step-2']);
  });

  // ────────────────────────────────────────────────────────
  // Retry with exponential backoff
  // ────────────────────────────────────────────────────────

  it('retries a failing step and succeeds within maxRetries', async () => {
    // Use zero-delay retry config to keep tests fast
    const wf = makeWorkflow({
      steps: [{
        id: 'step-1',
        name: 'Flaky Step',
        action: 'noop',
        retry: { maxRetries: 2, initialDelayMs: 0, backoffMultiplier: 1 },
      }],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    // Fail once, then succeed on the second call
    dispatchSpy
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce({ noop: true });

    // Make sleep instant
    jest.spyOn(engine as AnyEngine, 'sleep').mockResolvedValue(undefined);

    const run = await engine.trigger('wf-test');

    expect(run.success).toBe(true);
    expect(run.stepResults['step-1']?.attempts).toBe(2);
  });

  it('fails after all retries are exhausted', async () => {
    const wf = makeWorkflow({
      steps: [{
        id: 'step-1',
        name: 'Always Fails',
        action: 'noop',
        retry: { maxRetries: 2, initialDelayMs: 0, backoffMultiplier: 1 },
      }],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    dispatchSpy.mockRejectedValue(new Error('persistent error'));

    jest.spyOn(engine as AnyEngine, 'sleep').mockResolvedValue(undefined);

    const run = await engine.trigger('wf-test');

    expect(run.success).toBe(false);
    // maxRetries=2 means 1 initial + 2 retries = 3 total attempts
    expect(run.stepResults['step-1']?.attempts).toBe(3);
  });

  // ────────────────────────────────────────────────────────
  // Dead-Letter Queue
  // ────────────────────────────────────────────────────────

  it('writes a failed step to the DLQ after all retries are exhausted', async () => {
    const wf = makeWorkflow({
      steps: [{
        id: 'step-dlq',
        name: 'DLQ Step',
        action: 'noop',
        retry: { maxRetries: 1, initialDelayMs: 0, backoffMultiplier: 1 },
      }],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    dispatchSpy.mockRejectedValue(new Error('dlq error'));

    jest.spyOn(engine as AnyEngine, 'sleep').mockResolvedValue(undefined);

    await engine.trigger('wf-test');

    expect(fsMock.appendFileSync).toHaveBeenCalledTimes(1);
    const [calledPath, calledContent] = fsMock.appendFileSync.mock.calls[0] as [string, string, string];
    expect(calledPath).toMatch(/workflow-dlq\.jsonl$/);
    const entry = JSON.parse((calledContent as string).trim()) as Record<string, unknown>;
    expect(entry['stepId']).toBe('step-dlq');
    expect(entry['workflowId']).toBe('wf-test');
    expect(entry['error']).toBe('dlq error');
  });

  // ────────────────────────────────────────────────────────
  // State persistence
  // ────────────────────────────────────────────────────────

  it('persists workflow run state after each step', async () => {
    engine.registerWorkflow(makeWorkflow());
    await engine.trigger('wf-test');

    // writeFileSync should have been called at least once during execution
    expect(fsMock.writeFileSync).toHaveBeenCalled();

    const [savedPath, savedData] = fsMock.writeFileSync.mock.calls[0] as [string, string, string];
    expect(savedPath).toMatch(/wf-test\.json$/);
    const state = JSON.parse(savedData as string) as WorkflowRunResult;
    expect(state.workflowId).toBe('wf-test');
  });

  it('clears persisted state on workflow completion', async () => {
    fsMock.existsSync.mockReturnValue(true);
    engine.registerWorkflow(makeWorkflow());
    await engine.trigger('wf-test');

    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    const [unlinkedPath] = fsMock.unlinkSync.mock.calls[0] as [string];
    expect(unlinkedPath).toMatch(/wf-test\.json$/);
  });

  it('loadPersistedState returns null when no file exists', () => {
    fsMock.existsSync.mockReturnValue(false);
    const state = engine.loadPersistedState('wf-test');
    expect(state).toBeNull();
  });

  it('loadPersistedState deserialises a saved run', () => {
    const savedRun = {
      runId: 'run-abc',
      workflowId: 'wf-test',
      startedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      success: false,
      stepResults: {},
    };
    fsMock.existsSync.mockReturnValue(true);
    (fsMock.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(savedRun));

    engine.registerWorkflow(makeWorkflow());
    const loaded = engine.loadPersistedState('wf-test');

    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe('run-abc');
    expect(loaded?.startedAt).toBeInstanceOf(Date);
  });

  // ────────────────────────────────────────────────────────
  // Workflow cancellation
  // ────────────────────────────────────────────────────────

  it('stops execution after cancellation is requested between steps', async () => {
    const executedSteps: string[] = [];

    const wf = makeWorkflow({
      steps: [
        { id: 'step-1', name: 'Step 1', action: 'noop' },
        { id: 'step-2', name: 'Step 2', action: 'noop' },
        { id: 'step-3', name: 'Step 3', action: 'noop' },
      ],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    dispatchSpy.mockImplementation(async () => {
      executedSteps.push(`step-${String(executedSteps.length + 1)}`);
      if (executedSteps.length === 1) {
        // Request cancellation after step-1 executes
        await engine.cancelWorkflow('wf-test');
      }
      return { noop: true };
    });

    const run = await engine.trigger('wf-test');

    expect(run.cancelled).toBe(true);
    // Only step-1 should have executed; step-2 and step-3 should be skipped
    expect(executedSteps).toEqual(['step-1']);
  });

  it('cancelWorkflow throws when workflowId is not registered', async () => {
    await expect(engine.cancelWorkflow('non-existent')).rejects.toThrow('Workflow not found');
  });

  // ────────────────────────────────────────────────────────
  // Event emission
  // ────────────────────────────────────────────────────────

  it('emits workflow:started, workflow:step:complete, and workflow:complete events', async () => {
    const events: string[] = [];
    engine.on('workflow:started', () => events.push('workflow:started'));
    engine.on('workflow:step:complete', () => events.push('workflow:step:complete'));
    engine.on('workflow:complete', () => events.push('workflow:complete'));

    engine.registerWorkflow(makeWorkflow({
      steps: [{ id: 'step-1', name: 'Step 1', action: 'noop' }],
    }));
    await engine.trigger('wf-test');

    expect(events).toContain('workflow:started');
    expect(events).toContain('workflow:step:complete');
    expect(events).toContain('workflow:complete');
  });

  it('emits workflow:step:failed when a step fails (no retry)', async () => {
    const events: string[] = [];
    engine.on('workflow:step:failed', () => events.push('workflow:step:failed'));

    const wf = makeWorkflow({
      steps: [{
        id: 'step-fail',
        name: 'Failing Step',
        action: 'noop',
        retry: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1 },
      }],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    dispatchSpy.mockRejectedValue(new Error('fail'));

    const run = await engine.trigger('wf-test');

    expect(run.success).toBe(false);
    expect(events).toContain('workflow:step:failed');
  });

  it('emits workflow:cancelled when the workflow is cancelled', async () => {
    const events: string[] = [];
    engine.on('workflow:cancelled', () => events.push('workflow:cancelled'));

    const wf = makeWorkflow({
      steps: [
        { id: 'step-1', name: 'Step 1', action: 'noop' },
        { id: 'step-2', name: 'Step 2', action: 'noop' },
      ],
    });
    engine.registerWorkflow(wf);

    const dispatchSpy = jest.spyOn(engine as AnyEngine, 'dispatchAction');
    let callCount = 0;
    dispatchSpy.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Request cancellation after step-1 executes; step-2 should be skipped
        await engine.cancelWorkflow('wf-test');
      }
      return { noop: true };
    });

    const run = await engine.trigger('wf-test');

    expect(run.cancelled).toBe(true);
    expect(events).toContain('workflow:cancelled');
  });
});
