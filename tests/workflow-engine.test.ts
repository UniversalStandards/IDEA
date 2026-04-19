/**
 * tests/workflow-engine.test.ts
 * Unit tests for src/orchestration/workflow-engine.ts
 */

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
    gauge: jest.fn(),
  },
}));

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  appendFile: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

import { WorkflowEngine } from '../src/orchestration/workflow-engine';
import type { Workflow } from '../src/orchestration/workflow-engine';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'test-wf',
    name: 'Test Workflow',
    trigger: { type: 'manual', config: {} },
    steps: [],
    enabled: true,
    ...overrides,
  };
}

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    jest.useFakeTimers();
    engine = new WorkflowEngine();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('simple sequential workflow executes all steps in order', async () => {
    const executedSteps: string[] = [];

    engine.on('workflow:step:complete', (data: unknown) => {
      executedSteps.push((data as { stepId: string }).stepId);
    });

    const wf = makeWorkflow({
      id: 'seq-wf',
      steps: [
        { id: 'step-1', name: 'Step 1', action: 'noop' },
        { id: 'step-2', name: 'Step 2', action: 'noop' },
        { id: 'step-3', name: 'Step 3', action: 'noop' },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('seq-wf');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(executedSteps).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('step failure triggers retry up to maxRetries', async () => {
    const stepFailedEvents: unknown[] = [];
    engine.on('workflow:step:failed', (data) => stepFailedEvents.push(data));

    // 'emit_event' with no 'event' param throws → step always fails
    const wf = makeWorkflow({
      id: 'retry-wf',
      steps: [
        {
          id: 'failing-step',
          name: 'Failing Step',
          action: 'emit_event',
          params: {},
          maxRetries: 2,
          initialDelayMs: 0,
          backoffMultiplier: 1,
        },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('retry-wf');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    // 1 initial attempt + 2 retries = 3 total failures
    expect(stepFailedEvents).toHaveLength(3);
  });

  it('workflow cancellation stops further step execution', async () => {
    let capturedRunId = '';
    engine.once('workflow:started', (data: unknown) => {
      capturedRunId = (data as { runId: string }).runId;
    });

    // step-1 sleeps (pauses execution), step-2 should never run
    const wf = makeWorkflow({
      id: 'cancel-wf',
      steps: [
        { id: 'step-1', name: 'Slow Step', action: 'sleep', params: { ms: 10_000 } },
        { id: 'step-2', name: 'Should Not Run', action: 'noop' },
      ],
    });

    engine.registerWorkflow(wf);

    // Start workflow without awaiting — it will pause at the sleep timer
    const promise = engine.trigger('cancel-wf');

    // capturedRunId is set synchronously by the 'workflow:started' emit
    await engine.cancelWorkflow(capturedRunId);

    // Fire the sleep timer so execution resumes and hits the cancellation check
    jest.runAllTimers();

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.stepResults['step-2']).toBeUndefined();
  });

  it('failed workflow after all retries emits workflow:complete with success=false', async () => {
    const completeEvents: unknown[] = [];
    engine.on('workflow:complete', (data) => completeEvents.push(data));

    const wf = makeWorkflow({
      id: 'fail-wf',
      steps: [
        {
          id: 'bad-step',
          name: 'Always Fails',
          action: 'emit_event',
          params: {},
          maxRetries: 1,
          initialDelayMs: 0,
          backoffMultiplier: 1,
        },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('fail-wf');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(completeEvents).toHaveLength(1);
    expect((completeEvents[0] as { success: boolean }).success).toBe(false);
  });

  it('workflow state events are emitted in order', async () => {
    const events: string[] = [];

    engine.on('workflow:started', () => events.push('started'));
    engine.on('workflow:step:complete', () => events.push('step-complete'));
    engine.on('workflow:complete', () => events.push('complete'));

    const wf = makeWorkflow({
      id: 'events-wf',
      steps: [
        { id: 's1', name: 'Step 1', action: 'noop' },
        { id: 's2', name: 'Step 2', action: 'noop' },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('events-wf');
    await jest.runAllTimersAsync();
    await promise;

    expect(events).toEqual(['started', 'step-complete', 'step-complete', 'complete']);
  });

  it('permanently failed workflow writes a DLQ entry', async () => {
    const fsp = require('fs/promises') as Record<string, jest.Mock>;

    const wf = makeWorkflow({
      id: 'dlq-wf',
      steps: [
        {
          id: 'dlq-step',
          name: 'Always Fails',
          action: 'emit_event', // missing 'event' param → always throws
          params: {},
          maxRetries: 0,       // no retries → immediately permanent failure
          initialDelayMs: 0,
          backoffMultiplier: 1,
        },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('dlq-wf');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    // appendFile must have been called once with the DLQ path
    expect(fsp['appendFile']).toHaveBeenCalledTimes(1);
    const [dlqPath, dlqContent] = fsp['appendFile']!.mock.calls[0] as [string, string];
    expect(dlqPath).toMatch(/workflow-dlq\.jsonl$/);
    const entry = JSON.parse(dlqContent.trim()) as Record<string, unknown>;
    expect(entry['workflowId']).toBe('dlq-wf');
    expect(typeof entry['error']).toBe('string');
  });

  it('workflow state is persisted after each step and cleaned up on success', async () => {
    const fsp = require('fs/promises') as Record<string, jest.Mock>;

    const wf = makeWorkflow({
      id: 'persist-wf',
      steps: [
        { id: 'p1', name: 'Step 1', action: 'noop' },
        { id: 'p2', name: 'Step 2', action: 'noop' },
      ],
    });

    engine.registerWorkflow(wf);
    const promise = engine.trigger('persist-wf');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    // writeFile is called once per step to persist intermediate state
    expect(fsp['writeFile']).toHaveBeenCalled();
    const writeCall = fsp['writeFile']!.mock.calls[0] as [string, string];
    expect(writeCall[0]).toMatch(/workflows\/.*\.json$/);
    const persisted = JSON.parse(writeCall[1]) as Record<string, unknown>;
    expect(persisted['workflowId']).toBe('persist-wf');
    // On success the state file is deleted
    expect(fsp['unlink']).toHaveBeenCalled();
  });

  it('throws when triggering a non-existent workflow', async () => {
    await expect(engine.trigger('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('throws when triggering a disabled workflow', async () => {
    const wf = makeWorkflow({ id: 'disabled-wf', enabled: false });
    engine.registerWorkflow(wf);
    await expect(engine.trigger('disabled-wf')).rejects.toThrow(/disabled/i);
  });

  it('empty workflow (no steps) succeeds immediately', async () => {
    const wf = makeWorkflow({ id: 'empty-wf', steps: [] });
    engine.registerWorkflow(wf);
    const result = await engine.trigger('empty-wf');
    expect(result.success).toBe(true);
    expect(Object.keys(result.stepResults)).toHaveLength(0);
  });

  it('getRunHistory returns completed runs', async () => {
    const wf = makeWorkflow({ id: 'history-wf', steps: [{ id: 's1', name: 'S1', action: 'noop' }] });
    engine.registerWorkflow(wf);
    const promise = engine.trigger('history-wf');
    await jest.runAllTimersAsync();
    await promise;
    const history = engine.getRunHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.workflowId).toBe('history-wf');
  });

  it('listWorkflows returns registered workflows', () => {
    const wf1 = makeWorkflow({ id: 'wf-1', name: 'WF 1' });
    const wf2 = makeWorkflow({ id: 'wf-2', name: 'WF 2' });
    engine.registerWorkflow(wf1);
    engine.registerWorkflow(wf2);
    const list = engine.listWorkflows();
    const ids = list.map((w) => w.id);
    expect(ids).toContain('wf-1');
    expect(ids).toContain('wf-2');
  });

  it('getWorkflow returns the workflow by ID', () => {
    const wf = makeWorkflow({ id: 'get-wf' });
    engine.registerWorkflow(wf);
    expect(engine.getWorkflow('get-wf')?.id).toBe('get-wf');
    expect(engine.getWorkflow('nonexistent')).toBeUndefined();
  });

  it('event-triggered workflow fires when the event is emitted', async () => {
    const wf = makeWorkflow({
      id: 'event-wf',
      trigger: { type: 'event', config: { event: 'test:my-event' } },
      steps: [{ id: 'ev-step', name: 'Event Step', action: 'noop' }],
    });
    engine.registerWorkflow(wf);

    // Emit the trigger event — engine should auto-trigger the workflow
    const completePromise = new Promise<void>((resolve) => {
      engine.once('workflow:complete', () => resolve());
    });

    engine.emit('test:my-event', { source: 'test' });
    await jest.runAllTimersAsync();
    await completePromise;

    const history = engine.getRunHistory();
    expect(history.some((r) => r.workflowId === 'event-wf')).toBe(true);
  });

  it('event trigger with no eventName in config does NOT wire listener', () => {
    const wf = makeWorkflow({
      id: 'no-event-name-wf',
      trigger: { type: 'event', config: {} }, // no 'event' key
      steps: [{ id: 's1', name: 'S1', action: 'noop' }],
    });
    // Should not throw
    expect(() => engine.registerWorkflow(wf)).not.toThrow();
  });

  it('cancelWorkflow is safe to call multiple times', async () => {
    await engine.cancelWorkflow('nonexistent-run');
    await engine.cancelWorkflow('nonexistent-run');
    // No error thrown
  });

  it('step with onFailure jumps to the designated failure step', async () => {
    const wf = makeWorkflow({
      id: 'on-failure-wf',
      steps: [
        {
          id: 'failing-step',
          name: 'Fails',
          action: 'emit_event',
          params: {},
          maxRetries: 0,
          onFailure: 'recovery-step',
        },
        { id: 'recovery-step', name: 'Recovery', action: 'noop' },
      ],
    });
    engine.registerWorkflow(wf);
    const promise = engine.trigger('on-failure-wf');
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result.stepResults['recovery-step']?.success).toBe(true);
  });

  it('log action records a log entry and returns { logged: true }', async () => {
    const wf = makeWorkflow({
      id: 'log-wf',
      steps: [{ id: 'log-step', name: 'Log Step', action: 'log', params: { message: 'Hello' } }],
    });
    engine.registerWorkflow(wf);
    const promise = engine.trigger('log-wf');
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect((result.stepResults['log-step']?.output as { logged: boolean })?.logged).toBe(true);
  });

  it('emit_event action emits the named event and returns { emitted: eventName }', async () => {
    const emittedEvents: string[] = [];
    engine.on('custom:test-event', () => emittedEvents.push('custom:test-event'));

    const wf = makeWorkflow({
      id: 'emit-wf',
      steps: [
        {
          id: 'emit-step',
          name: 'Emit Step',
          action: 'emit_event',
          params: { event: 'custom:test-event', data: { foo: 'bar' } },
        },
      ],
    });
    engine.registerWorkflow(wf);
    const promise = engine.trigger('emit-wf');
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect(emittedEvents).toContain('custom:test-event');
  });

  it('unknown action dispatches a custom action:* event', async () => {
    const dispatched: unknown[] = [];
    engine.on('action:custom-action', (data) => dispatched.push(data));

    const wf = makeWorkflow({
      id: 'custom-action-wf',
      steps: [{ id: 'ca-step', name: 'Custom', action: 'custom-action', params: { x: 1 } }],
    });
    engine.registerWorkflow(wf);
    const promise = engine.trigger('custom-action-wf');
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect(dispatched.length).toBeGreaterThan(0);
  });
});
