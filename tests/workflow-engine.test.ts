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
});
