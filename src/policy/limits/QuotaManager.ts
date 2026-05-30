import { EventEmitter } from 'events';
import { z } from 'zod';
import { OrgQuotaConfigStore } from './QuotaConfig';
import { QuotaStore, type OrgUsageState } from './QuotaStore';

export const OrgQuotaSchema = z.object({
  callsPerDay: z.number().int().positive().optional(),
  tokensPerMonth: z.number().int().positive().optional(),
  computeSecondsPerHour: z.number().int().positive().optional(),
  alertThresholds: z.array(z.number().min(0).max(1)).default([0.8, 1.0]),
});

export type OrgQuota = z.infer<typeof OrgQuotaSchema>;
export type OrgQuotaInput = z.input<typeof OrgQuotaSchema>;

export const QuotaUsageSchema = z.object({
  calls: z.number().int().nonnegative().default(0),
  tokens: z.number().int().nonnegative().default(0),
  computeSeconds: z.number().int().nonnegative().default(0),
});

export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

export interface QuotaDecision {
  allowed: boolean;
  reason: string;
  exceededDimensions: Array<'calls' | 'tokens' | 'compute'>;
  statusCode?: 429;
  headers?: Record<string, string>;
}

function toDayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toMonthBucket(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 7);
}

function toHourBucket(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 13);
}

function toNextUtcHour(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1, 0, 0, 0));
}

function toNextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
}

function toNextUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export class QuotaManager extends EventEmitter {
  private readonly quotas = new Map<string, OrgQuota>();
  private readonly usage = new Map<string, OrgUsageState>();
  private readonly warningMarks = new Map<string, Set<string>>();

  constructor(
    private readonly quotaStore: QuotaStore = new QuotaStore(),
    private readonly configStore: OrgQuotaConfigStore = new OrgQuotaConfigStore(),
  ) {
    super();
  }

  configureOrg(orgId: string, quota: OrgQuotaInput): void {
    this.quotas.set(orgId, OrgQuotaSchema.parse(quota));
  }

  consume(orgId: string, usage: QuotaUsage, now: Date = new Date()): QuotaDecision {
    const parsedUsage = QuotaUsageSchema.parse(usage);
    const quota = this.resolveQuota(orgId);

    if (!quota) {
      return { allowed: true, reason: 'No quota configured', exceededDimensions: [] };
    }

    const state = this.getOrResetState(orgId, now);

    const nextCalls = state.callsUsed + parsedUsage.calls;
    const nextTokens = state.tokensUsed + parsedUsage.tokens;
    const nextCompute = state.computeSecondsUsed + parsedUsage.computeSeconds;

    const exceededDimensions: Array<'calls' | 'tokens' | 'compute'> = [];

    if (quota.callsPerDay !== undefined && nextCalls >= quota.callsPerDay) {
      exceededDimensions.push('calls');
    }

    if (quota.tokensPerMonth !== undefined && nextTokens >= quota.tokensPerMonth) {
      exceededDimensions.push('tokens');
    }

    if (quota.computeSecondsPerHour !== undefined && nextCompute >= quota.computeSecondsPerHour) {
      exceededDimensions.push('compute');
    }

    this.emitWarnings(orgId, quota, { callsUsed: nextCalls, tokensUsed: nextTokens, computeSecondsUsed: nextCompute });

    if (exceededDimensions.length > 0) {
      const safeOrgId = orgId.replace(/[\r\n\t]/gu, '_');
      const reason = `Quota exceeded for org ${safeOrgId}: ${exceededDimensions.join(', ')}`;
      const retryAfterSeconds = this.computeRetryAfterSeconds(exceededDimensions, now);
      this.emit('quota.exceeded', {
        orgId,
        reason,
        exceededDimensions,
        usage: parsedUsage,
        retryAfterSeconds,
      });

      return {
        allowed: false,
        reason,
        exceededDimensions,
        statusCode: 429,
        headers: { 'Retry-After': String(retryAfterSeconds) },
      };
    }

    state.callsUsed = nextCalls;
    state.tokensUsed = nextTokens;
    state.computeSecondsUsed = nextCompute;
    this.quotaStore.saveUsage(orgId, state);

    return {
      allowed: true,
      reason: 'Within quota',
      exceededDimensions: [],
    };
  }

  getUsage(orgId: string, now: Date = new Date()): OrgUsageState {
    return { ...this.getOrResetState(orgId, now) };
  }

  getQuotaForOrg(orgId: string): OrgQuota | undefined {
    return this.resolveQuota(orgId);
  }

  private getOrResetState(orgId: string, now: Date): OrgUsageState {
    const dayBucket = toDayBucket(now);
    const monthBucket = toMonthBucket(now);
    const hourBucket = toHourBucket(now);

    const existing = this.usage.get(orgId) ?? this.quotaStore.loadUsage(orgId) ?? undefined;
    if (!existing) {
      const initial: OrgUsageState = {
        dayBucket,
        monthBucket,
        hourBucket,
        callsUsed: 0,
        tokensUsed: 0,
        computeSecondsUsed: 0,
      };
      this.usage.set(orgId, initial);
      this.quotaStore.saveUsage(orgId, initial);
      return initial;
    }

    if (existing.dayBucket !== dayBucket) {
      existing.dayBucket = dayBucket;
      existing.callsUsed = 0;
      this.warningMarks.delete(orgId);
    }

    if (existing.monthBucket !== monthBucket) {
      existing.monthBucket = monthBucket;
      existing.tokensUsed = 0;
      this.warningMarks.delete(orgId);
    }

    if (existing.hourBucket !== hourBucket) {
      existing.hourBucket = hourBucket;
      existing.computeSecondsUsed = 0;
      this.warningMarks.delete(orgId);
    }

    this.usage.set(orgId, existing);
    this.quotaStore.saveUsage(orgId, existing);
    return existing;
  }

  private resolveQuota(orgId: string): OrgQuota | undefined {
    const configured = this.quotas.get(orgId);
    if (configured) {
      return configured;
    }

    const fromPolicy = this.configStore.loadOrgConfig(orgId);
    const derived: OrgQuota = OrgQuotaSchema.parse({
      callsPerDay: fromPolicy.quota.day.apiCalls,
      tokensPerMonth: fromPolicy.quota.month.tokens,
      computeSecondsPerHour: fromPolicy.quota.hour.computeSeconds,
      alertThresholds: fromPolicy.quota.alertThresholds,
    });

    if (
      derived.callsPerDay === undefined &&
      derived.tokensPerMonth === undefined &&
      derived.computeSecondsPerHour === undefined
    ) {
      return undefined;
    }
    this.quotas.set(orgId, derived);
    return derived;
  }

  private emitWarnings(
    orgId: string,
    quota: OrgQuota,
    usage: { callsUsed: number; tokensUsed: number; computeSecondsUsed: number },
  ): void {
    const thresholds = quota.alertThresholds.filter((value) => value < 1).sort((a, b) => a - b);
    const marks = this.warningMarks.get(orgId) ?? new Set<string>();
    this.warningMarks.set(orgId, marks);

    const dimensions: Array<{ key: 'calls' | 'tokens' | 'compute'; used: number; limit: number | undefined }> = [
      { key: 'calls', used: usage.callsUsed, limit: quota.callsPerDay },
      { key: 'tokens', used: usage.tokensUsed, limit: quota.tokensPerMonth },
      { key: 'compute', used: usage.computeSecondsUsed, limit: quota.computeSecondsPerHour },
    ];

    for (const threshold of thresholds) {
      for (const dimension of dimensions) {
        if (dimension.limit === undefined || dimension.limit <= 0) continue;
        if (dimension.used / dimension.limit < threshold) continue;

        const mark = `${dimension.key}:${threshold.toFixed(4)}`;
        if (marks.has(mark)) continue;
        marks.add(mark);
        this.emit('quota.warning', {
          orgId,
          threshold,
          dimension: dimension.key,
          usage: dimension.used,
          limit: dimension.limit,
        });
      }
    }
  }

  private computeRetryAfterSeconds(exceededDimensions: Array<'calls' | 'tokens' | 'compute'>, now: Date): number {
    const retryCandidates: number[] = [];
    if (exceededDimensions.includes('calls')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcDay(now).getTime() - now.getTime()) / 1000)));
    }
    if (exceededDimensions.includes('tokens')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcMonth(now).getTime() - now.getTime()) / 1000)));
    }
    if (exceededDimensions.includes('compute')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcHour(now).getTime() - now.getTime()) / 1000)));
    }
    return Math.min(...retryCandidates);
  }
}
