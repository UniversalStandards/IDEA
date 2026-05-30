import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const OrgUsageStateSchema = z.object({
  dayBucket: z.string().min(1),
  monthBucket: z.string().min(1),
  hourBucket: z.string().min(1),
  callsUsed: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  computeSecondsUsed: z.number().int().nonnegative(),
});

export type OrgUsageState = z.infer<typeof OrgUsageStateSchema>;

export class QuotaStore {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string = path.join(process.cwd(), 'runtime', 'quota-state.sqlite')) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quotas (
        org_id TEXT PRIMARY KEY,
        day_bucket TEXT NOT NULL,
        month_bucket TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        calls_used INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        compute_seconds_used INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
  }

  loadUsage(orgId: string): OrgUsageState | null {
    const stmt = this.db.prepare(`
      SELECT day_bucket, month_bucket, hour_bucket, calls_used, tokens_used, compute_seconds_used
      FROM quotas
      WHERE org_id = ?
    `);
    const row = stmt.get(orgId) as
      | {
          day_bucket: string;
          month_bucket: string;
          hour_bucket: string;
          calls_used: number;
          tokens_used: number;
          compute_seconds_used: number;
        }
      | undefined;

    if (!row) return null;
    return OrgUsageStateSchema.parse({
      dayBucket: row.day_bucket,
      monthBucket: row.month_bucket,
      hourBucket: row.hour_bucket,
      callsUsed: row.calls_used,
      tokensUsed: row.tokens_used,
      computeSecondsUsed: row.compute_seconds_used,
    });
  }

  saveUsage(orgId: string, state: OrgUsageState): void {
    const parsed = OrgUsageStateSchema.parse(state);
    const stmt = this.db.prepare(`
      INSERT INTO quotas (org_id, day_bucket, month_bucket, hour_bucket, calls_used, tokens_used, compute_seconds_used, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET
        day_bucket = excluded.day_bucket,
        month_bucket = excluded.month_bucket,
        hour_bucket = excluded.hour_bucket,
        calls_used = excluded.calls_used,
        tokens_used = excluded.tokens_used,
        compute_seconds_used = excluded.compute_seconds_used,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      orgId,
      parsed.dayBucket,
      parsed.monthBucket,
      parsed.hourBucket,
      parsed.callsUsed,
      parsed.tokensUsed,
      parsed.computeSecondsUsed,
      new Date().toISOString(),
    );
  }

  resetPeriod(period: 'hour' | 'day' | 'month', bucketValue: string): number {
    if (period === 'hour') {
      const stmt = this.db.prepare(`
        UPDATE quotas
        SET hour_bucket = ?, compute_seconds_used = 0, updated_at = ?
        WHERE hour_bucket <> ?
      `);
      const result = stmt.run(bucketValue, new Date().toISOString(), bucketValue);
      return Number(result.changes);
    }

    if (period === 'day') {
      const stmt = this.db.prepare(`
        UPDATE quotas
        SET day_bucket = ?, calls_used = 0, updated_at = ?
        WHERE day_bucket <> ?
      `);
      const result = stmt.run(bucketValue, new Date().toISOString(), bucketValue);
      return Number(result.changes);
    }

    const stmt = this.db.prepare(`
      UPDATE quotas
      SET month_bucket = ?, tokens_used = 0, updated_at = ?
      WHERE month_bucket <> ?
    `);
    const result = stmt.run(bucketValue, new Date().toISOString(), bucketValue);
    return Number(result.changes);
  }
}
