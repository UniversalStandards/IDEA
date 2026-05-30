import { AgentRouter } from '../src/orchestration/agent-router';
import { WorkflowEngine, WorkflowState } from '../src/orchestration/WorkflowEngine';
import { InMemoryWorkflowCheckpointStore, CheckpointManager } from '../src/orchestration/resilience/CheckpointManager';
import { DoomLoopDetector } from '../src/orchestration/resilience/DoomLoopDetector';
import { HumanGate, HumanGateNotificationClient, HumanGateRequest } from '../src/orchestration/resilience/HumanGate';
import { KillSwitch } from '../src/orchestration/resilience/KillSwitch';
import { SagaOrchestrator } from '../src/orchestration/resilience/SagaOrchestrator';
import { SpeculativeExecutor, SpeculativePredictor, SpeculativeToolRunner } from '../src/orchestration/performance/SpeculativeExecutor';

class RecordingNotifier implements HumanGateNotificationClient {
  readonly messages: Array<{ channel: string; request: HumanGateRequest }> = [];

  async send(channel: 'webhook' | 'slack' | 'email', request: HumanGateRequest): Promise<void> {
    this.messages.push({ channel, request });
  }
}

class DeterministicPredictor implements SpeculativePredictor {
  constructor(private readonly predictions: Record<string, Array<{ toolName: string; input: unknown }>>) {}

  async predictNextActions(
    _history: Array<{ toolName: string; input: unknown }>,
    currentAction: { toolName: string; input: unknown },
  ): Promise<Array<{ toolName: string; input: unknown }>> {
    return this.predictions[currentAction.toolName] ?? [];
  }
}

class EchoToolRunner implements SpeculativeToolRunner {
  async run(toolName: string, input: unknown): Promise<unknown> {
    return { toolName, input, speculative: true };
  }
}

describe('orchestration resilience', () => {
  it('human gate sends notifications and resumes on approval', async () => {
    const notifier = new RecordingNotifier();
    const humanGate = new HumanGate(notifier);

    const { requestId, decision } = await humanGate.requestApproval({
      orgId: 'org-1',
      workflowId: 'wf-1',
      stepId: 'step-1',
      channels: ['webhook', 'slack', 'email'],
      metadata: { operation: 'sensitive' },
    });

    expect(notifier.messages).toHaveLength(3);
    expect(humanGate.listPending('wf-1')).toHaveLength(1);

    humanGate.approve(requestId);
    await expect(decision).resolves.toBe('approved');
  });

  it('checkpoint manager stores and resumes state within target latency', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const manager = new CheckpointManager<{ value: string }>(store);

    const checkpoint = await manager.checkpoint({
      orgId: 'org-1',
      workflowId: 'wf-1',
      sequence: 1,
      milestone: 'node-a',
      state: { value: 'hello' },
    });

    expect(checkpoint.durationMs).toBeLessThan(100);

    const resumed = await manager.resume('org-1', 'wf-1');
    expect(resumed).not.toBeNull();
    expect(resumed!.durationMs).toBeLessThan(500);
    expect(resumed!.state).toEqual({ value: 'hello' });
  });

  it('saga orchestrator compensates completed steps in reverse order on failure', async () => {
    const saga = new SagaOrchestrator();
    const compensationOrder: string[] = [];

    await saga.executeStep({
      stepId: '1',
      execute: async () => 'ok-1',
      compensate: async () => {
        compensationOrder.push('1');
      },
    });

    await saga.executeStep({
      stepId: '2',
      execute: async () => 'ok-2',
      compensate: async () => {
        compensationOrder.push('2');
      },
    });

    await saga.rollback();
    expect(compensationOrder).toEqual(['2', '1']);
  });

  it('doom loop detector triggers at default threshold', () => {
    const detector = new DoomLoopDetector();

    for (let i = 0; i < 4; i += 1) {
      expect(
        detector.recordStep({
          workflowId: 'wf-1',
          agentId: 'agent-a',
          toolName: 'tool-x',
          toolInput: { prompt: 'repeat' },
        }).detected,
      ).toBe(false);
    }

    const result = detector.recordStep({
      workflowId: 'wf-1',
      agentId: 'agent-a',
      toolName: 'tool-x',
      toolInput: { prompt: 'repeat' },
    });
    expect(result.detected).toBe(true);
  });

  it('speculative executor reaches at least 50% prediction accuracy', async () => {
    const predictor = new DeterministicPredictor({
      a: [{ toolName: 'b', input: { n: 2 } }],
      b: [{ toolName: 'c', input: { n: 3 } }],
      c: [{ toolName: 'miss', input: { n: 99 } }],
      d: [{ toolName: 'd', input: { n: 4 } }],
    });

    const speculative = new SpeculativeExecutor(predictor, new EchoToolRunner());

    await speculative.prefetch([], { toolName: 'a', input: { n: 1 } });
    expect(speculative.consume('b', { n: 2 }).hit).toBe(true);

    await speculative.prefetch([], { toolName: 'b', input: { n: 2 } });
    expect(speculative.consume('c', { n: 3 }).hit).toBe(true);

    await speculative.prefetch([], { toolName: 'c', input: { n: 3 } });
    expect(speculative.consume('x', { n: 0 }).hit).toBe(false);

    await speculative.prefetch([], { toolName: 'd', input: { n: 4 } });
    expect(speculative.consume('not-d', { n: 4 }).hit).toBe(false);

    expect(speculative.getAccuracy()).toBeGreaterThanOrEqual(0.5);
  });

  it('kill switch terminates all active workflows for an org and notifies', async () => {
    const notifier = new RecordingNotifier();
    const killSwitch = new KillSwitch(notifier, ['webhook']);

    const terminated: string[] = [];
    killSwitch.register({
      orgId: 'org-1',
      workflowId: 'wf-1',
      terminate: async () => {
        terminated.push('wf-1');
      },
    });
    killSwitch.register({
      orgId: 'org-1',
      workflowId: 'wf-2',
      terminate: async () => {
        terminated.push('wf-2');
      },
    });

    const started = Date.now();
    const result = await killSwitch.trigger('org-1', 'emergency');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(result.terminatedWorkflowIds.sort()).toEqual(['wf-1', 'wf-2']);
    expect(terminated.sort()).toEqual(['wf-1', 'wf-2']);
    expect(notifier.messages.some((message) => message.request.stepId === 'kill-switch')).toBe(true);
  });

  it('workflow engine applies gates, checkpoints, speculation, and kill-switch checks', async () => {
    const router = new AgentRouter();
    router.registerAgent({
      agentId: 'agent-1',
      capabilities: ['tool'],
      priority: 1,
      maxLoad: 2,
      currentLoad: 0,
    });

    const notifier = new RecordingNotifier();
    const humanGate = new HumanGate(notifier);
    const checkpointManager = new CheckpointManager<WorkflowState>(new InMemoryWorkflowCheckpointStore());
    const saga = new SagaOrchestrator();
    const doomLoop = new DoomLoopDetector();
    const killSwitch = new KillSwitch(notifier, ['webhook']);
    const speculative = new SpeculativeExecutor(
      new DeterministicPredictor({
        prepare: [{ toolName: 'execute', input: { payload: 'go' } }],
      }),
      new EchoToolRunner(),
    );

    const engine = new WorkflowEngine(
      router,
      humanGate,
      checkpointManager,
      saga,
      doomLoop,
      killSwitch,
      speculative,
    );

    const runPromise = engine.execute({
      orgId: 'org-1',
      workflowId: 'wf-main',
      checkpointEvery: 1,
      humanGateChannels: ['webhook', 'email'],
      steps: [
        {
          id: 'prepare',
          agentId: 'agent-1',
          toolName: 'prepare',
          input: { payload: 'go' },
          majorNode: true,
          requiresHumanApproval: true,
          run: async () => ({ prepared: true }),
        },
        {
          id: 'execute',
          agentId: 'agent-1',
          toolName: 'execute',
          input: { payload: 'go' },
          majorNode: true,
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = humanGate.listPending('wf-main');
    expect(pending).toHaveLength(1);
    humanGate.approve(pending[0]!.requestId);

    const state = await runPromise;
    expect(state.status).toBe('completed');
    expect(state.results['prepare']).toEqual({ prepared: true });
    expect(state.results['execute']).toEqual({ toolName: 'execute', input: { payload: 'go' }, speculative: true });

    const resumed = await engine.resumeFromCheckpoint('org-1', 'wf-main');
    expect(resumed).not.toBeNull();
    expect(resumed!.state.status).toBe('completed');
  });
});
