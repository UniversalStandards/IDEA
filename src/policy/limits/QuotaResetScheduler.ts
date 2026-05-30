import type { PolicyAuditLog } from '../audit/PolicyAuditLog';
import type { QuotaStore } from './QuotaStore';

function toDayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toMonthBucket(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function toHourBucket(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export class QuotaResetScheduler {
  private interval: NodeJS.Timeout | null = null;
  private lastHourBucket = '';
  private lastDayBucket = '';
  private lastMonthBucket = '';

  constructor(
    private readonly quotaStore: QuotaStore,
    private readonly policyAuditLog?: PolicyAuditLog,
    private readonly intervalMs: number = 30_000,
  ) {}

  start(): void {
    if (this.interval) return;
    this.runPendingResets();
    this.interval = setInterval(() => this.runPendingResets(), this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  runPendingResets(now: Date = new Date()): void {
    const monthBucket = toMonthBucket(now);
    const dayBucket = toDayBucket(now);
    const hourBucket = toHourBucket(now);

    if (this.lastMonthBucket !== monthBucket) {
      this.lastMonthBucket = monthBucket;
      const changed = this.quotaStore.resetPeriod('month', monthBucket);
      this.logReset('month', changed, monthBucket);
    }

    if (this.lastDayBucket !== dayBucket) {
      this.lastDayBucket = dayBucket;
      const changed = this.quotaStore.resetPeriod('day', dayBucket);
      this.logReset('day', changed, dayBucket);
    }

    if (this.lastHourBucket !== hourBucket) {
      this.lastHourBucket = hourBucket;
      const changed = this.quotaStore.resetPeriod('hour', hourBucket);
      this.logReset('hour', changed, hourBucket);
    }
  }

  private logReset(period: 'hour' | 'day' | 'month', affectedRows: number, bucket: string): void {
    if (!this.policyAuditLog) return;
    this.policyAuditLog.append({
      orgId: 'global',
      actor: 'system:quota-reset-scheduler',
      action: `policy.quota.reset.${period}`,
      resource: `quota:${period}`,
      decision: 'allow',
      reason: `Reset ${period} quota counters`,
      metadata: { affectedRows, bucket },
    });
  }
}
