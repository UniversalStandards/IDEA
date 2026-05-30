import { EventEmitter } from 'events';
import type { DatabaseSync } from 'node:sqlite';
import { CostAttributor, type AttributeInput, type AttributionContext } from './CostAttributor';
import { UsageEventSchema, type UsageEvent } from '../types/billing.types';

export interface MeteringInterceptorContext extends AttributionContext {
  model?: string;
  toolName?: string;
}

export class UsageMetering extends EventEmitter {
  private readonly insertStmt;
  private readonly queue: UsageEvent[] = [];
  private processing = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly attributor: CostAttributor = new CostAttributor(),
  ) {
    super();
    this.insertStmt = this.db.prepare(`
      INSERT INTO usage_events (
        id, org_id, workflow_id, agent_id, event_type, model, model_tier, tool_name,
        tokens_in, tokens_out, api_calls, compute_seconds, cost_usd, timestamp, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  record(input: AttributeInput): UsageEvent {
    const event = this.attributor.attribute(input);
    this.enqueue(event);
    return event;
  }

  async interceptLLMCall<T>(
    context: MeteringInterceptorContext,
    operation: () => Promise<{ result: T; tokensIn: number; tokensOut: number; model?: string; metadata?: Record<string, unknown> }>,
  ): Promise<T> {
    const executed = await operation();
    const input: AttributeInput = {
      ...context,
      eventType: 'llm_call',
      tokensIn: executed.tokensIn,
      tokensOut: executed.tokensOut,
    };
    const model = executed.model ?? context.model;
    if (model !== undefined) input.model = model;
    if (executed.metadata !== undefined) input.metadata = executed.metadata;
    this.record(input);
    return executed.result;
  }

  async interceptToolExecution<T>(
    context: MeteringInterceptorContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = process.hrtime.bigint();
    const result = await operation();
    const durationNs = process.hrtime.bigint() - started;
    this.record({
      ...context,
      eventType: 'tool_execution',
      apiCalls: 1,
      computeSeconds: Number(durationNs) / 1_000_000_000,
      metadata: { durationNs: durationNs.toString() },
    });
    return result;
  }

  async recordComputeSeconds(context: MeteringInterceptorContext, computeSeconds: number): Promise<UsageEvent> {
    return this.record({
      ...context,
      eventType: 'compute_second',
      computeSeconds,
    });
  }

  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  private enqueue(event: UsageEvent): void {
    this.queue.push(UsageEventSchema.parse(event));
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => {
        this.flush();
      });
    }
  }

  private flush(): void {
    const batch = this.queue.splice(0, this.queue.length);

    if (batch.length === 0) {
      this.processing = false;
      return;
    }

    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const event of batch) {
        this.insertStmt.run(
          event.id,
          event.orgId,
          event.workflowId,
          event.agentId,
          event.eventType,
          event.model ?? null,
          event.modelTier ?? null,
          event.toolName ?? null,
          event.tokensIn ?? null,
          event.tokensOut ?? null,
          event.apiCalls,
          event.computeSeconds,
          event.costUsd,
          event.timestamp,
          JSON.stringify(event.metadata),
        );
      }
      this.db.exec('COMMIT');
      this.emit('usage.recorded', { count: batch.length });
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failures when no transaction is active
      }
      this.emit('usage.error', error);
    } finally {
      if (this.queue.length > 0) {
        setImmediate(() => {
          this.flush();
        });
      } else {
        this.processing = false;
      }
    }
  }
}
