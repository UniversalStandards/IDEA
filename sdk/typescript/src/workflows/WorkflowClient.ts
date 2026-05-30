import type { WorkflowState } from '../types';
import type { HttpClient } from '../http';

export interface WorkflowRunResponse {
  readonly runId: string;
  readonly streamId?: string;
  readonly status?: string;
}

export interface WorkflowListFilters {
  readonly workflowId?: string;
  readonly status?: string;
  readonly tenantId?: string;
}

export class WorkflowClient {
  private readonly http: HttpClient;

  public constructor(http: HttpClient) {
    this.http = http;
  }

  public async run(workflowId: string, input: Record<string, unknown>): Promise<WorkflowRunResponse> {
    return this.http.post<WorkflowRunResponse>('/workflows/run', {
      body: { workflowId, input },
    });
  }

  public async list(filters?: WorkflowListFilters): Promise<WorkflowState[]> {
    const response = await this.http.get<{ runs?: WorkflowState[]; items?: WorkflowState[] }>('/workflows', {
      query: {
        workflowId: filters?.workflowId,
        status: filters?.status,
        tenantId: filters?.tenantId,
      },
    });

    return response.runs ?? response.items ?? [];
  }

  public async cancel(runId: string): Promise<{ cancelled: boolean }> {
    return this.http.post<{ cancelled: boolean }>(`/workflows/${encodeURIComponent(runId)}/cancel`);
  }

  public async getStatus(runId: string): Promise<WorkflowState> {
    return this.http.get<WorkflowState>(`/workflows/${encodeURIComponent(runId)}/status`);
  }
}
