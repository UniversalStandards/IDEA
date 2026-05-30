export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
}

export interface UsageEvent {
  readonly id: string;
  readonly orgId: string;
  readonly workflowId: string;
  readonly agentId: string;
  readonly eventType: 'token_usage' | 'tool_execution' | 'workflow_execution' | 'adjustment';
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd: number;
  readonly timestamp: string;
}

export interface CostRecord {
  readonly orgId: string;
  readonly period: BillingPeriod;
  readonly totalCostUsd: number;
  readonly breakdown: Record<string, number>;
}

export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitCostUsd: number;
  readonly totalCostUsd: number;
}

export interface Invoice {
  readonly id: string;
  readonly orgId: string;
  readonly period: BillingPeriod;
  readonly lineItems: InvoiceLine[];
  readonly totalUsd: number;
  readonly status: 'draft' | 'issued' | 'paid' | 'void';
}
