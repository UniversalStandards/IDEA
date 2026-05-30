import { EventEmitter } from 'events';
import type { DatabaseSync } from 'node:sqlite';
import { BudgetSchema, type Budget } from '../types/billing.types';
import { QuotaManager, type QuotaUsage } from '../policy/limits/QuotaManager';

export interface BudgetDecision {
  allowed: boolean;
  statusCode: number;
  reason: string;
  monthlySpendUsd: number;
  monthlyBudgetUsd: number;
}

export class BudgetEnforcer extends EventEmitter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly quotaManager: QuotaManager = new QuotaManager(),
  ) {
    super();
  }

  configureBudget(budget: Budget): void {
    const parsed = BudgetSchema.parse(budget);
    this.db
      .prepare(
        `INSERT INTO budgets(org_id, monthly_budget_usd, alert_threshold_pct, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
          monthly_budget_usd=excluded.monthly_budget_usd,
          alert_threshold_pct=excluded.alert_threshold_pct,
          updated_at=excluded.updated_at`,
      )
      .run(parsed.orgId, parsed.monthlyBudgetUsd, parsed.alertThresholdPct, Date.now());
  }

  enforce(orgId: string, incrementalCostUsd: number, quotaUsage?: QuotaUsage): BudgetDecision {
    const budgetRow = this.db
      .prepare('SELECT monthly_budget_usd as monthlyBudgetUsd, alert_threshold_pct as alertThresholdPct FROM budgets WHERE org_id = ?')
      .get(orgId) as unknown as { monthlyBudgetUsd: number; alertThresholdPct: number } | undefined;

    const monthlyBudgetUsd = budgetRow?.monthlyBudgetUsd ?? Number.POSITIVE_INFINITY;
    const alertThresholdPct = budgetRow?.alertThresholdPct ?? 0.8;
    const monthlySpendUsd = this.getMonthlySpend(orgId);
    const projected = monthlySpendUsd + incrementalCostUsd;

    if (quotaUsage) {
      const quotaDecision = this.quotaManager.consume(orgId, quotaUsage);
      if (!quotaDecision.allowed) {
        return {
          allowed: false,
          statusCode: 402,
          reason: quotaDecision.reason,
          monthlySpendUsd,
          monthlyBudgetUsd,
        };
      }
    }

    if (Number.isFinite(monthlyBudgetUsd) && projected > monthlyBudgetUsd) {
      const reason = `Budget exceeded for org ${orgId}: ${projected.toFixed(4)} > ${monthlyBudgetUsd.toFixed(4)}`;
      this.emit('budget.exceeded', {
        orgId,
        monthlySpendUsd,
        projectedSpendUsd: projected,
        monthlyBudgetUsd,
      });

      return {
        allowed: false,
        statusCode: 402,
        reason,
        monthlySpendUsd,
        monthlyBudgetUsd,
      };
    }

    if (Number.isFinite(monthlyBudgetUsd) && projected >= monthlyBudgetUsd * alertThresholdPct) {
      this.emit('budget.alert', {
        orgId,
        monthlySpendUsd,
        projectedSpendUsd: projected,
        monthlyBudgetUsd,
        alertThresholdPct,
      });
    }

    return {
      allowed: true,
      statusCode: 200,
      reason: 'Within budget',
      monthlySpendUsd,
      monthlyBudgetUsd,
    };
  }

  getMonthlySpend(orgId: string, now = new Date()): number {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_events WHERE org_id = ? AND timestamp >= ? AND timestamp < ?')
      .get(orgId, start, end) as unknown as { total: number };
    return row.total;
  }
}
