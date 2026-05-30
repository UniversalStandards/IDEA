import type { DatabaseSync } from 'node:sqlite';

export interface DateRange {
  startMs: number;
  endMs: number;
}

export class FinOpsDashboard {
  constructor(private readonly db: DatabaseSync) {}

  costByOrg(month: string): Array<{ orgId: string; totalUsd: number }> {
    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthNum = Number(monthStr);
    const start = Date.UTC(year, monthNum - 1, 1);
    const end = Date.UTC(year, monthNum, 1);

    return this.db
      .prepare(
        `SELECT org_id as orgId, ROUND(COALESCE(SUM(cost_usd), 0), 6) as totalUsd
         FROM usage_events
         WHERE timestamp >= ? AND timestamp < ?
         GROUP BY org_id
         ORDER BY totalUsd DESC`,
      )
      .all(start, end) as unknown as Array<{ orgId: string; totalUsd: number }>;
  }

  topWorkflows(orgId: string, limit = 10): Array<{ workflowId: string; totalUsd: number }> {
    return this.db
      .prepare(
        `SELECT workflow_id as workflowId, ROUND(COALESCE(SUM(cost_usd), 0), 6) as totalUsd
         FROM usage_events
         WHERE org_id = ?
         GROUP BY workflow_id
         ORDER BY totalUsd DESC
         LIMIT ?`,
      )
      .all(orgId, limit) as unknown as Array<{ workflowId: string; totalUsd: number }>;
  }

  costByModelTier(orgId: string, period: DateRange): Array<{ modelTier: string; totalUsd: number }> {
    return this.db
      .prepare(
        `SELECT COALESCE(model_tier, 'unknown') as modelTier, ROUND(COALESCE(SUM(cost_usd), 0), 6) as totalUsd
         FROM usage_events
         WHERE org_id = ? AND timestamp >= ? AND timestamp < ?
         GROUP BY COALESCE(model_tier, 'unknown')
         ORDER BY totalUsd DESC`,
      )
      .all(orgId, period.startMs, period.endMs) as unknown as Array<{ modelTier: string; totalUsd: number }>;
  }

  dailySpend(orgId: string, days: number): Array<{ day: string; totalUsd: number }> {
    const end = Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;

    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as day,
                ROUND(COALESCE(SUM(cost_usd), 0), 6) as totalUsd
         FROM usage_events
         WHERE org_id = ? AND timestamp >= ?
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(orgId, start) as unknown as Array<{ day: string; totalUsd: number }>;
  }

  projectedMonthEnd(orgId: string, now: Date = new Date()): { month: string; currentSpendUsd: number; projectedSpendUsd: number } {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as totalUsd
         FROM usage_events
         WHERE org_id = ? AND timestamp >= ? AND timestamp < ?`,
      )
      .get(orgId, start, end) as unknown as { totalUsd: number };

    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected = dayOfMonth > 0 ? (row.totalUsd / dayOfMonth) * daysInMonth : row.totalUsd;

    return {
      month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
      currentSpendUsd: Number(row.totalUsd.toFixed(6)),
      projectedSpendUsd: Number(projected.toFixed(6)),
    };
  }
}
