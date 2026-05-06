import { EventEmitter } from 'events';
import { z } from 'zod';

export const OrgQuotaSchema = z.object({
  callsPerDay: z.number().int().positive().optional(),
  tokensPerMonth: z.number().int().positive().optional(),
  computeSecondsPerHour: z.number().int().positive().optional(),
});

export type OrgQuota = z.infer<typeof OrgQuotaSchema>;

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
}

interface OrgUsageState {
  dayBucket: string;
  monthBucket: string;
  hourBucket: string;
  callsUsed: number;
  tokensUsed: number;
  computeSecondsUsed: number;
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

export class QuotaManager extends EventEmitter {
  private readonly quotas = new Map<string, OrgQuota>();
  private readonly usage = new Map<string, OrgUsageState>();

  configureOrg(orgId: string, quota: OrgQuota): void {
    this.quotas.set(orgId, OrgQuotaSchema.parse(quota));
  }

  consume(orgId: string, usage: QuotaUsage, now: Date = new Date()): QuotaDecision {
    const parsedUsage = QuotaUsageSchema.parse(usage);
    const quota = this.quotas.get(orgId);

    if (!quota) {
      return { allowed: true, reason: 'No quota configured', exceededDimensions: [] };
    }

    const state = this.getOrResetState(orgId, now);

    const nextCalls = state.callsUsed + parsedUsage.calls;
    const nextTokens = state.tokensUsed + parsedUsage.tokens;
    const nextCompute = state.computeSecondsUsed + parsedUsage.computeSeconds;

    const exceededDimensions: Array<'calls' | 'tokens' | 'compute'> = [];

    if (quota.callsPerDay !== undefined && nextCalls > quota.callsPerDay) {
      exceededDimensions.push('calls');
    }

    if (quota.tokensPerMonth !== undefined && nextTokens > quota.tokensPerMonth) {
      exceededDimensions.push('tokens');
    }

    if (quota.computeSecondsPerHour !== undefined && nextCompute > quota.computeSecondsPerHour) {
      exceededDimensions.push('compute');
    }

    if (exceededDimensions.length > 0) {
      const reason = `Quota exceeded for org ${orgId}: ${exceededDimensions.join(', ')}`;
      this.emit('quota.exceeded', {
        orgId,
        reason,
        exceededDimensions,
        usage: parsedUsage,
      });

      return {
        allowed: false,
        reason,
        exceededDimensions,
      };
    }

    state.callsUsed = nextCalls;
    state.tokensUsed = nextTokens;
    state.computeSecondsUsed = nextCompute;

    return {
      allowed: true,
      reason: 'Within quota',
      exceededDimensions: [],
    };
  }

  getUsage(orgId: string, now: Date = new Date()): OrgUsageState {
    return { ...this.getOrResetState(orgId, now) };
  }

  private getOrResetState(orgId: string, now: Date): OrgUsageState {
    const dayBucket = toDayBucket(now);
    const monthBucket = toMonthBucket(now);
    const hourBucket = toHourBucket(now);

    const existing = this.usage.get(orgId);
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
      return initial;
    }

    if (existing.dayBucket !== dayBucket) {
      existing.dayBucket = dayBucket;
      existing.callsUsed = 0;
    }

    if (existing.monthBucket !== monthBucket) {
      existing.monthBucket = monthBucket;
      existing.tokensUsed = 0;
    }

    if (existing.hourBucket !== hourBucket) {
      existing.hourBucket = hourBucket;
      existing.computeSecondsUsed = 0;
    }

    return existing;
  }
}
