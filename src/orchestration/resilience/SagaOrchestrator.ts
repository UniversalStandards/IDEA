export interface SagaStepContext {
  orgId: string;
  workflowId: string;
}

export interface SagaExecutionStep {
  stepId: string;
  execute: () => Promise<unknown>;
  compensate: () => Promise<void>;
}

export class SagaOrchestrator {
  private readonly completedSteps: SagaExecutionStep[] = [];

  async executeStep(step: SagaExecutionStep): Promise<unknown> {
    const result = await step.execute();
    this.completedSteps.push(step);
    return result;
  }

  async rollback(): Promise<void> {
    const compensationErrors: Error[] = [];
    for (let i = this.completedSteps.length - 1; i >= 0; i -= 1) {
      const step = this.completedSteps[i];
      if (!step) {
        continue;
      }
      try {
        await step.compensate();
      } catch (error) {
        compensationErrors.push(error as Error);
      }
    }
    this.completedSteps.length = 0;

    if (compensationErrors.length > 0) {
      throw new Error(`Saga rollback failed: ${compensationErrors.map((err) => err.message).join('; ')}`);
    }
  }

  clear(): void {
    this.completedSteps.length = 0;
  }
}
