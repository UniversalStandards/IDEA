/**
 * src/observability/cost-monitor.ts
 * Per-provider AI and tool execution cost tracking.
 * Records cost events in memory, aggregates by provider/model/window.
 * Emits warnings when daily budget thresholds are crossed.
 */

import { createLogger } from './logger';
import { getConfig } from '../config';
import { auditLog } from '../security/audit';
import type { CostEvent, CostSummary } from '../types/index';

const logger = createLogger('cost-monitor');

// Exported as a class for direct instantiation in tests
export class CostMonitor {
  private readonly events: CostEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 50_000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Record a cost event. No-op when COST_TRACKING_ENABLED=false.
   */
  record(event: Omit<CostEvent, 'timestamp'>): void {
    let enabled = true;
    try { enabled = getConfig().COST_TRACKING_ENABLED; } catch { /* use default */ }
    if (!enabled) return;

    const fullEvent: CostEvent = { ...event, timestamp: new Date() };
    this.events.push(fullEvent);

    // Bound memory usage: drop oldest events when over capacity
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    // Budget alert check
    let dailyBudget = 0;
    try { dailyBudget = getConfig().COST_BUDGET_DAILY_USD; } catch { /* use default */ }
    if (dailyBudget > 0) {
      const daily = this.getCostSummary(24 * 60 * 60 * 1000);
      if (daily.totalCostUsd > dailyBudget) {
        logger.warn('Daily cost budget exceeded', {
          budget: dailyBudget,
          actual: daily.totalCostUsd,
          overage: daily.totalCostUsd - dailyBudget,
        });
      }
    }

    // Emit to audit log
    try {
      auditLog.record(
        'cost.event.recorded',
        'system',
        `${event.provider}/${event.model}`,
        'success',
        event.requestId,
        {
          costUsd: event.costUsd,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        },
      );
    } catch { /* non-fatal */ }
  }

  /**
   * Get aggregated cost summary for the given time window.
   * @param windowMs Window size in milliseconds (e.g. 24 * 60 * 60 * 1000 for 24h)
   */
  getCostSummary(windowMs: number): CostSummary {
    const cutoff = new Date(Date.now() - windowMs);
    const windowEvents = this.events.filter((e) => e.timestamp >= cutoff);

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCostUsd = 0;

    for (const e of windowEvents) {
      totalCostUsd += e.costUsd;
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.costUsd;
      byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
    }

    return {
      totalCostUsd,
      requestCount: windowEvents.length,
      byProvider,
      byModel,
      windowMs,
      from: cutoff,
      to: new Date(),
    };
  }

  /** Cost by provider over the last 24 hours. */
  getCostByProvider(): Record<string, number> {
    return this.getCostSummary(24 * 60 * 60 * 1000).byProvider;
  }

  /** Cost by model over the last 24 hours. */
  getCostByModel(): Record<string, number> {
    return this.getCostSummary(24 * 60 * 60 * 1000).byModel;
  }

  /** Clear all events. Used in tests. */
  clear(): void {
    this.events.splice(0);
  }

  /** Total number of recorded events (for monitoring). */
  getEventCount(): number {
    return this.events.length;
  }
}

/** Singleton instance for use across the application. */
export const costMonitor = new CostMonitor();
