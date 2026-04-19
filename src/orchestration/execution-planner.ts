import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { installer } from '../provisioning/installer';
import { registryManager } from '../discovery/registry-manager';
import { policyEngine } from '../policy/policy-engine';
import { runtimeRegistrar } from '../provisioning/runtime-registrar';
import { approvalGate } from '../policy/approval-gates';
import { toolClientPool } from '../core/mcp-client';

const logger = createLogger('execution-planner');

export interface ExecutionStep {
  id: string;
  type: 'discover' | 'install' | 'execute' | 'validate' | 'approve' | 'notify';
  toolId?: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
}

export interface ExecutionPlan {
  id: string;
  goal: string;
  steps: ExecutionStep[];
  estimatedDuration?: number;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecutionResult {
  planId: string;
  success: boolean;
  steps: Record<string, StepResult>;
  duration: number;
}

export class ExecutionPlanner {
  async plan(goal: string, context: Record<string, unknown>): Promise<ExecutionPlan> {
    logger.info('Planning execution', { goal });
    const planId = randomUUID();
    const steps: ExecutionStep[] = [];

    const toolId = context['toolId'] as string | undefined;
    const action = context['action'] as string | undefined;
    const params = context['params'] as Record<string, unknown> | undefined;
    const requiresApproval = context['requiresApproval'] as boolean | undefined;
    const sendNotification = context['notify'] as boolean | undefined;

    // Step 1: Discover the tool if we have a query but no toolId
    if (!toolId && context['query']) {
      const discoverStep: ExecutionStep = {
        id: `${planId}-discover`,
        type: 'discover',
        params: { query: context['query'], limit: 10 },
      };
      steps.push(discoverStep);
    }

    // Step 2: Validate policy
    const lastStepId = steps.length > 0 ? steps[steps.length - 1]?.id : undefined;
    const validateStep: ExecutionStep = {
      id: `${planId}-validate`,
      type: 'validate',
      ...(toolId !== undefined ? { toolId } : {}),
      params: { goal, action, actor: context['actor'] ?? 'system' },
      ...(lastStepId !== undefined ? { dependsOn: [lastStepId] } : {}),
    };
    steps.push(validateStep);

    // Step 3: Approval gate if required
    if (requiresApproval) {
      const approveStep: ExecutionStep = {
        id: `${planId}-approve`,
        type: 'approve',
        ...(toolId !== undefined ? { toolId } : {}),
        params: { reason: `Approval required for: ${goal}` },
        dependsOn: [validateStep.id],
      };
      steps.push(approveStep);
    }

    // Step 4: Install if tool not already registered
    if (toolId) {
      const registered = runtimeRegistrar.get(toolId);
      if (!registered) {
        const installStep: ExecutionStep = {
          id: `${planId}-install`,
          type: 'install',
          toolId,
          params: {},
          dependsOn: [steps[steps.length - 1]?.id ?? ''],
        };
        steps.push(installStep);
      }
    }

    // Step 5: Execute
    if (toolId && action) {
      const executeStep: ExecutionStep = {
        id: `${planId}-execute`,
        type: 'execute',
        toolId,
        params: { action, ...(params ?? {}) },
        dependsOn: [steps[steps.length - 1]?.id ?? ''],
      };
      steps.push(executeStep);
    }

    // Step 6: Notify on completion
    if (sendNotification) {
      const notifyStep: ExecutionStep = {
        id: `${planId}-notify`,
        type: 'notify',
        params: { goal, success: true },
        dependsOn: [steps[steps.length - 1]?.id ?? ''],
      };
      steps.push(notifyStep);
    }

    const estimatedDuration = steps.length * 500;

    const plan: ExecutionPlan = {
      id: planId,
      goal,
      steps,
      estimatedDuration,
    };

    logger.info('Execution plan created', { planId, stepCount: steps.length });
    metrics.increment('execution_plans_created_total');
    return plan;
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const startTime = Date.now();
    logger.info('Executing plan', { planId: plan.id, stepCount: plan.steps.length });

    const stepResults: Record<string, StepResult> = {};
    let overallSuccess = true;

    const completed = new Set<string>();
    const remaining = [...plan.steps];

    while (remaining.length > 0) {
      // Find steps whose dependencies are all complete
      const ready = remaining.filter((step) => {
        if (!step.dependsOn || step.dependsOn.length === 0) return true;
        return step.dependsOn.every((dep) => {
          const depResult = stepResults[dep];
          return depResult?.success === true;
        });
      });

      // Check if any step is blocked by a failed dependency
      const blocked = remaining.filter((step) => {
        if (!step.dependsOn || step.dependsOn.length === 0) return false;
        return step.dependsOn.some((dep) => {
          const depResult = stepResults[dep];
          return depResult !== undefined && !depResult.success;
        });
      });

      for (const step of blocked) {
        stepResults[step.id] = {
          stepId: step.id,
          success: false,
          error: 'Skipped due to dependency failure',
          durationMs: 0,
        };
        completed.add(step.id);
        remaining.splice(remaining.indexOf(step), 1);
        overallSuccess = false;
      }

      if (ready.length === 0 && remaining.length > 0) {
        // No progress possible
        for (const step of remaining) {
          stepResults[step.id] = {
            stepId: step.id,
            success: false,
            error: 'Could not execute: no runnable steps remaining',
            durationMs: 0,
          };
          overallSuccess = false;
        }
        break;
      }

      const results = await Promise.allSettled(
        ready.map((step) => this.executeStep(step)),
      );

      for (let i = 0; i < ready.length; i++) {
        const step = ready[i];
        const result = results[i];
        if (step === undefined || result === undefined) continue;

        remaining.splice(remaining.indexOf(step), 1);
        completed.add(step.id);

        if (result.status === 'fulfilled') {
          stepResults[step.id] = result.value;
          if (!result.value.success) overallSuccess = false;
        } else {
          stepResults[step.id] = {
            stepId: step.id,
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            durationMs: 0,
          };
          overallSuccess = false;
        }
      }
    }

    const duration = Date.now() - startTime;
    metrics.histogram('execution_plan_duration_ms', duration);
    metrics.increment('execution_plans_completed_total', {
      success: String(overallSuccess),
    });

    logger.info('Plan execution complete', {
      planId: plan.id,
      success: overallSuccess,
      durationMs: duration,
    });

    return { planId: plan.id, success: overallSuccess, steps: stepResults, duration };
  }

  private async executeStep(step: ExecutionStep): Promise<StepResult> {
    const start = Date.now();
    logger.debug('Executing step', { stepId: step.id, type: step.type });

    try {
      let output: unknown;

      switch (step.type) {
        case 'discover': {
          const query = (step.params?.['query'] as string) ?? '';
          const limit = (step.params?.['limit'] as number) ?? 10;
          output = await registryManager.search({ query, limit });
          break;
        }

        case 'install': {
          if (!step.toolId) throw new Error('install step requires toolId');
          const tool = await registryManager.getById(step.toolId);
          if (!tool) throw new Error(`Tool not found in registry: ${step.toolId}`);
          const result = await installer.install(tool);
          if (!result.success) throw new Error(result.error ?? 'Install failed');
          output = result;
          break;
        }

        case 'execute': {
          if (!step.toolId) throw new Error('execute step requires toolId');
          const registered = runtimeRegistrar.get(step.toolId);
          if (!registered) throw new Error(`Tool not registered: ${step.toolId}`);

          const toolName = (step.params?.['action'] as string | undefined) ?? step.toolId;
          const toolArgs = (step.params?.['args'] as Record<string, unknown> | undefined) ?? {};
          const timeoutMs = (step.params?.['timeoutMs'] as number | undefined);

          const client = toolClientPool.acquire(registered);
          output = await client.callTool(toolName, toolArgs, timeoutMs);
          break;
        }

        case 'validate': {
          const decision = policyEngine.evaluate({
            toolId: step.toolId ?? 'unknown',
            actor: (step.params?.['actor'] as string) ?? 'system',
            action: (step.params?.['action'] as string) ?? 'execute',
            environment: process.env['NODE_ENV'] ?? 'development',
          });
          if (!decision.allowed) {
            throw new Error(`Policy denied: ${decision.reasons.join(', ')}`);
          }
          output = decision;
          break;
        }

        case 'approve': {
          const requestedBy = (step.params?.['requestedBy'] as string | undefined) ?? 'system';
          const reason = (step.params?.['reason'] as string | undefined) ?? `Approval required for plan step ${step.id}`;
          output = await approvalGate.request(
            step.toolId ?? 'unknown',
            'execute',
            requestedBy,
            reason,
            { stepId: step.id, params: step.params },
          );
          break;
        }

        case 'notify': {
          logger.info('Plan notification', { goal: step.params?.['goal'], success: step.params?.['success'] });
          output = { notified: true };
          break;
        }

        default:
          throw new Error(`Unknown step type: ${(step as ExecutionStep).type}`);
      }

      const durationMs = Date.now() - start;
      return { stepId: step.id, success: true, output, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('Step failed', { stepId: step.id, type: step.type, error });
      return { stepId: step.id, success: false, error, durationMs };
    }
  }
}

export const executionPlanner = new ExecutionPlanner();
