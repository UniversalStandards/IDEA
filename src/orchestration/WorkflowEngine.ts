import { AgentRouter } from './agent-router';
import { SpeculativeAction, SpeculativeExecutor } from './performance/SpeculativeExecutor';
import { CheckpointManager } from './resilience/CheckpointManager';
import { DoomLoopDetector } from './resilience/DoomLoopDetector';
import { HumanGate, HumanGateChannel } from './resilience/HumanGate';
import { KillSwitch } from './resilience/KillSwitch';
import { SagaOrchestrator } from './resilience/SagaOrchestrator';

export interface WorkflowStep {
  id: string;
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  majorNode?: boolean;
  requiresHumanApproval?: boolean;
  run?: () => Promise<unknown>;
  compensate?: () => Promise<void>;
}

export interface WorkflowDefinition {
  orgId: string;
  workflowId: string;
  steps: WorkflowStep[];
  checkpointEvery?: number;
  humanGateChannels?: HumanGateChannel[];
}

export interface WorkflowState {
  orgId: string;
  workflowId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentStepIndex: number;
  results: Record<string, unknown>;
  history: SpeculativeAction[];
}

export class WorkflowEngine {
  constructor(
    private readonly router: AgentRouter,
    private readonly humanGate: HumanGate,
    private readonly checkpointManager: CheckpointManager<WorkflowState>,
    private readonly sagaOrchestrator: SagaOrchestrator,
    private readonly doomLoopDetector: DoomLoopDetector,
    private readonly killSwitch: KillSwitch,
    private readonly speculativeExecutor: SpeculativeExecutor,
  ) {}

  async execute(definition: WorkflowDefinition): Promise<WorkflowState> {
    let cancelled = false;
    const state: WorkflowState = {
      orgId: definition.orgId,
      workflowId: definition.workflowId,
      status: 'running',
      currentStepIndex: 0,
      results: {},
      history: [],
    };

    this.killSwitch.register({
      orgId: definition.orgId,
      workflowId: definition.workflowId,
      terminate: async () => {
        cancelled = true;
        state.status = 'cancelled';
      },
    });

    try {
      for (let index = state.currentStepIndex; index < definition.steps.length; index += 1) {
        if (cancelled || this.killSwitch.isKilled(definition.orgId)) {
          state.status = 'cancelled';
          break;
        }

        const step = definition.steps[index];
        if (!step) {
          state.status = 'failed';
          throw new Error(`Missing workflow step at index ${index}`);
        }
        state.currentStepIndex = index;

        const detection = this.doomLoopDetector.recordStep({
          workflowId: definition.workflowId,
          agentId: step.agentId,
          toolName: step.toolName,
          toolInput: step.input,
        });

        if (detection.detected) {
          state.status = 'paused';
          const { requestId, decision } = await this.humanGate.requestApproval({
            orgId: definition.orgId,
            workflowId: definition.workflowId,
            stepId: step.id,
            channels: definition.humanGateChannels ?? ['webhook'],
            metadata: { reason: 'doom-loop', signature: detection.signature },
            autoRejectAfterMs: 60_000,
          });

          const response = await decision;
          if (response !== 'approved') {
            state.status = 'cancelled';
            this.humanGate.cancel(requestId);
            break;
          }
          state.status = 'running';
          this.doomLoopDetector.reset(definition.workflowId);
        }

        if (step.requiresHumanApproval) {
          state.status = 'paused';
          const { decision } = await this.humanGate.requestApproval({
            orgId: definition.orgId,
            workflowId: definition.workflowId,
            stepId: step.id,
            channels: definition.humanGateChannels ?? ['webhook'],
            metadata: { reason: 'human-gate' },
          });
          const response = await decision;
          if (response !== 'approved') {
            state.status = 'cancelled';
            break;
          }
          state.status = 'running';
        }

        void this.speculativeExecutor.prefetch(state.history, {
          toolName: step.toolName,
          input: step.input,
        });

        try {
          const speculative = this.speculativeExecutor.consume(step.toolName, step.input);
          const result = speculative.hit
            ? speculative.result
            : step.run
              ? await step.run()
              : await this.router.delegate(step.agentId, {
                stepId: step.id,
                toolName: step.toolName,
                input: step.input,
              });

          await this.sagaOrchestrator.executeStep({
            stepId: step.id,
            execute: async () => result,
            compensate: step.compensate ?? (async () => {}),
          });

          state.results[step.id] = result;
          state.history.push({ toolName: step.toolName, input: step.input });

          const shouldCheckpoint =
            step.majorNode
            || Boolean(definition.checkpointEvery && (index + 1) % definition.checkpointEvery === 0);
          if (shouldCheckpoint) {
            await this.checkpointManager.checkpoint({
              orgId: definition.orgId,
              workflowId: definition.workflowId,
              sequence: index + 1,
              milestone: step.id,
              state,
            });
          }
        } catch (error) {
          state.status = 'failed';
          await this.sagaOrchestrator.rollback();
          throw error;
        }
      }

      if (state.status === 'running') {
        state.status = 'completed';
        await this.checkpointManager.checkpoint({
          orgId: definition.orgId,
          workflowId: definition.workflowId,
          sequence: definition.steps.length + 1,
          milestone: 'workflow-complete',
          state,
        });
      }
      return state;
    } finally {
      this.killSwitch.unregister(definition.orgId, definition.workflowId);
      this.doomLoopDetector.reset(definition.workflowId);
      this.sagaOrchestrator.clear();
    }
  }

  resumeFromCheckpoint(orgId: string, workflowId: string): Promise<{ state: WorkflowState; durationMs: number } | null> {
    return this.checkpointManager.resume(orgId, workflowId);
  }
}
