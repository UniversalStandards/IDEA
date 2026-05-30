import { randomUUID } from 'crypto';
import {
  CostRecordSchema,
  ModelPriceSchema,
  type CostRecord,
  type ModelPrice,
  type UsageEvent,
  UsageEventSchema,
} from '../types/billing.types';

export interface AttributionContext {
  orgId?: string;
  workflowId?: string;
  agentId?: string;
}

export interface AttributeInput extends AttributionContext {
  eventType: UsageEvent['eventType'];
  model?: string;
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
  apiCalls?: number;
  computeSeconds?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_PRICE_TABLE: ModelPrice[] = [
  {
    model: 'gpt-4o',
    tier: 'premium',
    inputPer1kTokensUsd: 0.005,
    outputPer1kTokensUsd: 0.015,
    toolExecutionUsd: 0.001,
    computeSecondUsd: 0.0002,
  },
  {
    model: 'gpt-4o-mini',
    tier: 'standard',
    inputPer1kTokensUsd: 0.00015,
    outputPer1kTokensUsd: 0.0006,
    toolExecutionUsd: 0.0002,
    computeSecondUsd: 0.0001,
  },
  {
    model: 'default',
    tier: 'standard',
    inputPer1kTokensUsd: 0.001,
    outputPer1kTokensUsd: 0.002,
    toolExecutionUsd: 0.0005,
    computeSecondUsd: 0.0001,
  },
];

export class CostAttributor {
  private readonly priceTable = new Map<string, ModelPrice>();

  constructor(prices: ModelPrice[] = DEFAULT_PRICE_TABLE) {
    for (const price of prices) {
      const parsed = ModelPriceSchema.parse(price);
      this.priceTable.set(parsed.model, parsed);
    }
  }

  upsertPrice(price: ModelPrice): void {
    const parsed = ModelPriceSchema.parse(price);
    this.priceTable.set(parsed.model, parsed);
  }

  attribute(input: AttributeInput): UsageEvent {
    const model = input.model ?? 'default';
    const price = this.priceTable.get(model) ?? this.priceTable.get('default');

    if (!price) {
      throw new Error('No model pricing configured');
    }

    const tokensIn = input.tokensIn ?? 0;
    const tokensOut = input.tokensOut ?? 0;
    const apiCalls = input.apiCalls ?? 0;
    const computeSeconds = input.computeSeconds ?? 0;

    const costUsd = this.computeCost(input.eventType, price, { tokensIn, tokensOut, apiCalls, computeSeconds });

    return UsageEventSchema.parse({
      id: randomUUID(),
      orgId: input.orgId ?? 'unknown-org',
      workflowId: input.workflowId ?? 'unknown-workflow',
      agentId: input.agentId ?? 'unknown-agent',
      eventType: input.eventType,
      model: input.model,
      modelTier: price.tier,
      toolName: input.toolName,
      tokensIn,
      tokensOut,
      apiCalls,
      computeSeconds,
      costUsd,
      timestamp: input.timestamp ?? Date.now(),
      metadata: input.metadata ?? {},
    });
  }

  toCostRecord(event: UsageEvent): CostRecord {
    return CostRecordSchema.parse({
      eventId: event.id,
      orgId: event.orgId,
      workflowId: event.workflowId,
      agentId: event.agentId,
      modelTier: event.modelTier,
      costUsd: event.costUsd,
      timestamp: event.timestamp,
    });
  }

  getModelTier(model?: string): string {
    if (!model) return 'standard';
    return (this.priceTable.get(model) ?? this.priceTable.get('default'))?.tier ?? 'standard';
  }

  getPriceTable(): ModelPrice[] {
    return Array.from(this.priceTable.values());
  }

  private computeCost(
    eventType: UsageEvent['eventType'],
    price: ModelPrice,
    usage: { tokensIn: number; tokensOut: number; apiCalls: number; computeSeconds: number },
  ): number {
    const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

    switch (eventType) {
      case 'llm_call':
        return round((usage.tokensIn / 1000) * price.inputPer1kTokensUsd + (usage.tokensOut / 1000) * price.outputPer1kTokensUsd);
      case 'tool_execution':
        return round(usage.apiCalls * price.toolExecutionUsd);
      case 'compute_second':
        return round(usage.computeSeconds * price.computeSecondUsd);
    }
  }
}
