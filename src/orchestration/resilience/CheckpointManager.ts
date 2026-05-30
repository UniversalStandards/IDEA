export interface WorkflowCheckpointRecord {
  orgId: string;
  workflowId: string;
  sequence: number;
  milestone: string;
  stateJson: string;
  createdAt: number;
}

export interface WorkflowCheckpointStore {
  upsert(record: WorkflowCheckpointRecord): Promise<void>;
  getLatest(orgId: string, workflowId: string): Promise<WorkflowCheckpointRecord | null>;
}

export class InMemoryWorkflowCheckpointStore implements WorkflowCheckpointStore {
  private readonly records = new Map<string, WorkflowCheckpointRecord[]>();

  async upsert(record: WorkflowCheckpointRecord): Promise<void> {
    const key = `${record.orgId}:${record.workflowId}`;
    const current = this.records.get(key) ?? [];
    current.push(record);
    current.sort((a, b) => (b.sequence - a.sequence) || (b.createdAt - a.createdAt));
    this.records.set(key, current);
  }

  async getLatest(orgId: string, workflowId: string): Promise<WorkflowCheckpointRecord | null> {
    const key = `${orgId}:${workflowId}`;
    return (this.records.get(key) ?? [])[0] ?? null;
  }
}

export class CheckpointManager<State extends object> {
  constructor(private readonly store: WorkflowCheckpointStore) {}

  async checkpoint(input: {
    orgId: string;
    workflowId: string;
    sequence: number;
    milestone: string;
    state: State;
  }): Promise<{ durationMs: number }> {
    const started = Date.now();
    await this.store.upsert({
      orgId: input.orgId,
      workflowId: input.workflowId,
      sequence: input.sequence,
      milestone: input.milestone,
      stateJson: JSON.stringify(input.state),
      createdAt: started,
    });
    return { durationMs: Date.now() - started };
  }

  async resume(orgId: string, workflowId: string): Promise<{ state: State; durationMs: number } | null> {
    const started = Date.now();
    const checkpoint = await this.store.getLatest(orgId, workflowId);
    if (!checkpoint) {
      return null;
    }

    return {
      state: JSON.parse(checkpoint.stateJson) as State,
      durationMs: Date.now() - started,
    };
  }
}
