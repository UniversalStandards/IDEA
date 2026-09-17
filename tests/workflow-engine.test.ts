import { WorkflowEngine, type Workflow } from '../src/orchestration/workflow-engine';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  function simpleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
    return {
      id: 'wf-1',
      name: 'Test Workflow',
      trigger: { type: 'manual', config: {} },
      enabled: true,
      steps: [
        { id: 'step1', name: 'Step 1', action: 'noop' },
        { id: 'step2', name: 'Step 2', action: 'noop' },
      ],
      ...overrides,
    };
  }

  it('executes a simple sequential workflow through all steps in order', async () => {
    engine.registerWorkflow(simpleWorkflow());
    const result = await engine.trigger('wf-1');

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(Object.keys(result.stepResults)).toEqual(['step1', 'step2']);
  });

  it('throws when triggering an unknown workflow', async () => {
    await expect(engine.trigger('nonexistent')).rejects.toThrow('Workflow not found');
  });

  it('throws when triggering a disabled workflow', async () => {
    engine.registerWorkflow(simpleWorkflow({ enabled: false }));
    await expect(engine.trigger('wf-1')).rejects.toThrow('disabled');
  });

  it('retries a failing step up to maxRetries before giving up', async () => {
    engine.registerWorkflow(
      simpleWorkflow({
        steps: [
          {
            id: 'flaky',
            name: 'Flaky Step',
            action: 'http_request', // throws synchronously with no url param
            retryPolicy: { maxRetries: 2, initialDelayMs: 1, backoffMultiplier: 1 },
          },
        ],
      }),
    );

    const result = await engine.trigger('wf-1');

    expect(result.success).toBe(false);
    expect(result.stepResults['flaky']?.attempts).toBe(3); // 1 initial + 2 retries
  });

  it('a step with onFailure routes to the failure step instead of throwing', async () => {
    engine.registerWorkflow(
      simpleWorkflow({
        steps: [
          { id: 'flaky', name: 'Flaky', action: 'http_request', onFailure: 'recover' },
          { id: 'recover', name: 'Recover', action: 'noop' },
        ],
      }),
    );

    const result = await engine.trigger('wf-1');

    expect(result.success).toBe(true);
    expect(result.stepResults['flaky']?.success).toBe(false);
    expect(result.stepResults['recover']?.success).toBe(true);
  });

  it('throws when a step with no onFailure exhausts its retries', async () => {
    engine.registerWorkflow(
      simpleWorkflow({
        steps: [{ id: 'flaky', name: 'Flaky', action: 'http_request' }],
      }),
    );

    const result = await engine.trigger('wf-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('flaky');
  });

  it('cancelWorkflow stops execution before the next step and marks the run cancelled', async () => {
    engine.registerWorkflow(
      simpleWorkflow({
        steps: [
          { id: 'step1', name: 'Step 1', action: 'sleep', params: { ms: 50 } },
          { id: 'step2', name: 'Step 2', action: 'noop' },
        ],
      }),
    );

    engine.on('workflow:started', (run: { runId: string }) => {
      void engine.cancelWorkflow(run.runId);
    });

    const result = await engine.trigger('wf-1');

    expect(result.status).toBe('cancelled');
    expect(result.stepResults['step2']).toBeUndefined();
  });

  it('throws when cancelling a runId that is not active', async () => {
    await expect(engine.cancelWorkflow('nonexistent-run-id')).rejects.toThrow();
  });

  it('getWorkflow and listWorkflows reflect registered workflows', () => {
    engine.registerWorkflow(simpleWorkflow());
    expect(engine.getWorkflow('wf-1')).toBeDefined();
    expect(engine.listWorkflows()).toHaveLength(1);
  });

  it('emits workflow:started and workflow:complete for a run', async () => {
    engine.registerWorkflow(simpleWorkflow());
    const started = jest.fn();
    const completed = jest.fn();
    engine.on('workflow:started', started);
    engine.on('workflow:complete', completed);

    await engine.trigger('wf-1');

    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('getRunHistory accumulates completed runs', async () => {
    engine.registerWorkflow(simpleWorkflow());
    await engine.trigger('wf-1');
    await engine.trigger('wf-1');
    expect(engine.getRunHistory()).toHaveLength(2);
  });
});
