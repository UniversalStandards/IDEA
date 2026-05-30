import { randomUUID } from 'crypto';

export type HumanGateChannel = 'webhook' | 'slack' | 'email';
export type HumanGateDecision = 'approved' | 'rejected' | 'cancelled';

export interface HumanGateRequest {
  requestId: string;
  orgId: string;
  workflowId: string;
  stepId: string;
  channels: HumanGateChannel[];
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface HumanGateNotificationClient {
  send(channel: HumanGateChannel, request: HumanGateRequest): Promise<void>;
}

interface PendingRequest {
  request: HumanGateRequest;
  resolve: (decision: HumanGateDecision) => void;
  timeout?: NodeJS.Timeout;
}

export class HumanGate {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly notifier: HumanGateNotificationClient) {}

  async requestApproval(input: {
    orgId: string;
    workflowId: string;
    stepId: string;
    channels: HumanGateChannel[];
    metadata?: Record<string, unknown>;
    autoRejectAfterMs?: number;
  }): Promise<{ requestId: string; decision: Promise<HumanGateDecision> }> {
    const request: HumanGateRequest = {
      requestId: randomUUID(),
      orgId: input.orgId,
      workflowId: input.workflowId,
      stepId: input.stepId,
      channels: input.channels,
      createdAt: Date.now(),
      metadata: input.metadata ?? {},
    };

    const decision = new Promise<HumanGateDecision>((resolve) => {
      const pending: PendingRequest = { request, resolve };

      if (input.autoRejectAfterMs && input.autoRejectAfterMs > 0) {
        pending.timeout = setTimeout(() => {
          this.resolveRequest(request.requestId, 'cancelled');
        }, input.autoRejectAfterMs);
      }

      this.pending.set(request.requestId, pending);
    });

    await Promise.all(request.channels.map((channel) => this.notifier.send(channel, request)));

    return { requestId: request.requestId, decision };
  }

  approve(requestId: string): boolean {
    return this.resolveRequest(requestId, 'approved');
  }

  reject(requestId: string): boolean {
    return this.resolveRequest(requestId, 'rejected');
  }

  cancel(requestId: string): boolean {
    return this.resolveRequest(requestId, 'cancelled');
  }

  listPending(workflowId?: string): HumanGateRequest[] {
    const requests = Array.from(this.pending.values()).map((entry) => entry.request);
    if (!workflowId) {
      return requests;
    }
    return requests.filter((request) => request.workflowId === workflowId);
  }

  private resolveRequest(requestId: string, decision: HumanGateDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }
}
