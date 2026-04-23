/**
 * tests/workflow-engine.test.ts
 * Unit tests for src/orchestration/workflow-engine.ts
 * All external I/O (axios, crypto.randomUUID) is mocked — tests are deterministic.
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

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

// Mock axios used inside the http_request action.
// With esModuleInterop + CommonJS, dynamic import() compiles via __importStar.
// Setting __esModule:true prevents double-wrapping of the default export.
const mockAxiosRequest = jest.fn().mockResolvedValue({ status: 200, data: { ok: true } });
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    request: mockAxiosRequest,
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { WorkflowEngine, Workflow, WorkflowStep } from '../src/orchestration/workflow-engine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let stepCounter = 0;
function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  stepCounter += 1;
  return {
    id: `step-${String(stepCounter)}`,
    name: `Step ${String(stepCounter)}`,
    action: 'noop',
    params: {},
    ...overrides,
  };
}

let workflowCounter = 0;

function makeWorkflow(
  steps: WorkflowStep[],
  enabled = true,
  trigger: Workflow['trigger'] = { type: 'manual', config: {} },
): Workflow {
  workflowCounter += 1;
  return {
    id: `wf-${String(workflowCounter)}`,
    name: 'Test Workflow',
    trigger,
    steps,
    enabled,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    stepCounter = 0;
    workflowCounter = 0;
    engine = new WorkflowEngine();
    // Ensure the axios mock resolves successfully for each test
    mockAxiosRequest.mockResolvedValue({ status: 200, data: { ok: true } });
  });

  // ── Workflow registration ────────────────────────────────────────────────

  describe('registerWorkflow() / listWorkflows() / getWorkflow()', () => {
    it('registers a workflow and makes it available via listWorkflows()', () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);
      expect(engine.listWorkflows().some((w) => w.id === wf.id)).toBe(true);
    });

    it('retrieves a registered workflow by ID via getWorkflow()', () => {
      const wf = makeWorkflow([]);
      engine.registerWorkflow(wf);
      expect(engine.getWorkflow(wf.id)).toBeDefined();
      expect(engine.getWorkflow(wf.id)!.id).toBe(wf.id);
    });

    it('returns undefined from getWorkflow() for an unknown ID', () => {
      expect(engine.getWorkflow('does-not-exist')).toBeUndefined();
    });

    it('lists all registered workflows', () => {
      engine.registerWorkflow(makeWorkflow([], true));
      engine.registerWorkflow(makeWorkflow([], true));
      expect(engine.listWorkflows().length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Sequential step execution ────────────────────────────────────────────

  describe('trigger() — sequential step execution', () => {
    it('executes a workflow with a single step and returns success', async () => {
      const wf = makeWorkflow([makeStep({ action: 'noop' })]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      expect(run.success).toBe(true);
      expect(run.workflowId).toBe(wf.id);
      expect(run.completedAt).toBeInstanceOf(Date);
    });

    it('executes all steps in order and records each step result', async () => {
      const step1 = makeStep({ action: 'noop' });
      const step2 = makeStep({ action: 'noop' });
      const wf = makeWorkflow([step1, step2]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      expect(run.success).toBe(true);
      expect(run.stepResults[step1.id]!.success).toBe(true);
      expect(run.stepResults[step2.id]!.success).toBe(true);
    });

    it('executes a workflow with no steps and returns success', async () => {
      const wf = makeWorkflow([]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(run.success).toBe(true);
    });

    it('passes input data through to the run result', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);

      const input = { key: 'value' };
      const run = await engine.trigger(wf.id, input);
      expect(run.input).toEqual(input);
    });

    it('sets a runId and startedAt timestamp on every run', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(typeof run.runId).toBe('string');
      expect(run.startedAt).toBeInstanceOf(Date);
    });
  });

  // ── Failure routing ──────────────────────────────────────────────────────

  describe('trigger() — step failure handling', () => {
    it('marks the run as failed when a step fails and there is no onFailure handler', async () => {
      const failStep = makeStep({ action: 'http_request', params: {} }); // missing url → throws
      const wf = makeWorkflow([failStep]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      expect(run.success).toBe(false);
      expect(run.error).toBeDefined();
    });

    it('routes to the onFailure step when a step fails and onFailure is specified', async () => {
      const recoveryStep = makeStep({ action: 'noop' });
      const failStep = makeStep({
        action: 'http_request',
        params: {}, // missing url → throws
        onFailure: recoveryStep.id,
      });
      const wf = makeWorkflow([failStep, recoveryStep]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      // Recovery step must have been executed
      expect(run.stepResults[recoveryStep.id]).toBeDefined();
      expect(run.stepResults[recoveryStep.id]!.success).toBe(true);
    });

    it('records the error message for a failed step', async () => {
      const failStep = makeStep({ action: 'http_request', params: {} });
      const wf = makeWorkflow([failStep]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      expect(run.stepResults[failStep.id]!.success).toBe(false);
      expect(run.stepResults[failStep.id]!.error).toBeDefined();
    });

    it('follows onSuccess chain when specified on a successful step', async () => {
      const step1 = makeStep({ action: 'noop' });
      const step3 = makeStep({ action: 'noop' }); // will be jumped to
      step1.onSuccess = step3.id;
      const step2 = makeStep({ action: 'noop' }); // should be skipped

      const wf = makeWorkflow([step1, step2, step3]);
      engine.registerWorkflow(wf);

      const run = await engine.trigger(wf.id);
      expect(run.stepResults[step1.id]).toBeDefined();
      expect(run.stepResults[step2.id]).toBeUndefined(); // jumped over
      expect(run.stepResults[step3.id]).toBeDefined();
    });
  });

  // ── Trigger validation ───────────────────────────────────────────────────

  describe('trigger() — guard clauses', () => {
    it('throws when triggering a workflow with an unknown ID', async () => {
      await expect(engine.trigger('unknown-wf')).rejects.toThrow('Workflow not found: unknown-wf');
    });

    it('throws when triggering a disabled workflow', async () => {
      const wf = makeWorkflow([makeStep()], false /* disabled */);
      engine.registerWorkflow(wf);
      await expect(engine.trigger(wf.id)).rejects.toThrow(`Workflow is disabled: ${wf.id}`);
    });
  });

  // ── Run history ──────────────────────────────────────────────────────────

  describe('getRunHistory()', () => {
    it('stores a completed run in the run history', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);
      await engine.trigger(wf.id);

      const history = engine.getRunHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
    });

    it('returns a defensive copy so external mutations do not affect internal state', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);
      await engine.trigger(wf.id);

      const copy = engine.getRunHistory();
      copy.splice(0, copy.length); // clear the copy
      expect(engine.getRunHistory().length).toBeGreaterThanOrEqual(1);
    });

    it('accumulates history across multiple runs of the same workflow', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);
      await engine.trigger(wf.id);
      await engine.trigger(wf.id);

      const history = engine.getRunHistory().filter((r) => r.workflowId === wf.id);
      expect(history.length).toBe(2);
    });
  });

  // ── Event emission ───────────────────────────────────────────────────────

  describe('workflow:completed event emission', () => {
    it('emits "workflow:completed" with the run result after a run finishes', async () => {
      const wf = makeWorkflow([makeStep()]);
      engine.registerWorkflow(wf);

      const spy = jest.fn();
      engine.on('workflow:completed', spy);

      await engine.trigger(wf.id);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ workflowId: wf.id }));
    });

    it('emits "workflow:completed" even when a run fails', async () => {
      const wf = makeWorkflow([makeStep({ action: 'http_request', params: {} })]);
      engine.registerWorkflow(wf);

      const spy = jest.fn();
      engine.on('workflow:completed', spy);

      await engine.trigger(wf.id);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Event-based trigger ──────────────────────────────────────────────────

  describe('event-based workflow trigger', () => {
    it('automatically triggers the workflow when the configured event is emitted', async () => {
      const wf: Workflow = {
        id: 'event-wf',
        name: 'Event Workflow',
        enabled: true,
        trigger: { type: 'event', config: { event: 'test:my-event' } },
        steps: [makeStep({ action: 'noop' })],
      };
      engine.registerWorkflow(wf);

      const completeSpy = jest.fn();
      engine.on('workflow:completed', completeSpy);

      // Emit the trigger event; the async trigger schedules a microtask via trigger()
      engine.emit('test:my-event', { data: 'payload' });

      // Flush all pending microtasks/promises so the async trigger can complete
      await Promise.resolve();
      // Give the workflow trigger one tick to reach completion
      await new Promise((resolve) => setImmediate(resolve));

      expect(completeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: 'event-wf' }),
      );
    });
  });

  // ── Built-in action dispatching ──────────────────────────────────────────

  describe('action dispatching', () => {
    it('executes a "log" action and returns { logged: true }', async () => {
      const wf = makeWorkflow([
        makeStep({ action: 'log', params: { message: 'hello from test' } }),
      ]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      const stepId = wf.steps[0]!.id;
      expect(run.stepResults[stepId]!.success).toBe(true);
      expect((run.stepResults[stepId]!.output as Record<string, unknown>)['logged']).toBe(true);
    });

    it('executes a "noop" action and returns { noop: true }', async () => {
      const step = makeStep({ action: 'noop' });
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect((run.stepResults[step.id]!.output as Record<string, unknown>)['noop']).toBe(true);
    });

    it('executes an "emit_event" action and emits the specified event', async () => {
      const customSpy = jest.fn();
      engine.on('custom:event', customSpy);

      const step = makeStep({
        action: 'emit_event',
        params: { event: 'custom:event', data: { key: 'value' } },
      });
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      await engine.trigger(wf.id);
      expect(customSpy).toHaveBeenCalled();
    });

    it('fails an "emit_event" action when the required "event" param is missing', async () => {
      const step = makeStep({ action: 'emit_event', params: {} }); // no event param
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(run.stepResults[step.id]!.success).toBe(false);
    });

    it('executes an "http_request" action and returns status and data', async () => {
      const step = makeStep({
        action: 'http_request',
        params: { url: 'https://example.com/api', method: 'GET' },
      });
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(run.stepResults[step.id]!.success).toBe(true);
      const output = run.stepResults[step.id]!.output as Record<string, unknown>;
      expect(output['status']).toBe(200);
    });

    it('fails an "http_request" action when the required "url" param is missing', async () => {
      const step = makeStep({ action: 'http_request', params: {} });
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(run.stepResults[step.id]!.success).toBe(false);
    });

    it('dispatches an unknown action as a custom event and returns dispatched info', async () => {
      const step = makeStep({ action: 'custom:do-something', params: { x: 1 } });
      const wf = makeWorkflow([step]);
      engine.registerWorkflow(wf);
      const run = await engine.trigger(wf.id);
      expect(run.stepResults[step.id]!.success).toBe(true);
      const output = run.stepResults[step.id]!.output as Record<string, unknown>;
      expect(output['dispatched']).toBe('custom:do-something');
    });
  });
});
