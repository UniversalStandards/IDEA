import { z } from 'zod';
import type { OrgQuota } from './QuotaManager';

const BudgetEnforcementInputSchema = z.object({
  orgId: z.string().min(1),
  now: z.date().default(() => new Date()),
  usage: z.object({
    callsUsed: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    computeSecondsUsed: z.number().int().nonnegative(),
  }),
  quota: z.object({
    callsPerDay: z.number().int().positive().optional(),
    tokensPerMonth: z.number().int().positive().optional(),
    computeSecondsPerHour: z.number().int().positive().optional(),
  }),
});

export interface BudgetEnforcementResult {
  allowed: boolean;
  statusCode?: 429;
  reason: string;
  headers: Record<string, string>;
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

export class BudgetEnforcer {
  enforce(input: {
    orgId: string;
    usage: { callsUsed: number; tokensUsed: number; computeSecondsUsed: number };
    quota: OrgQuota;
    now?: Date;
  }): BudgetEnforcementResult {
    const parsed = BudgetEnforcementInputSchema.parse({ ...input, now: input.now ?? new Date() });
    const exceededDimensions: Array<'calls' | 'tokens' | 'compute'> = [];

    if (parsed.quota.callsPerDay !== undefined && parsed.usage.callsUsed >= parsed.quota.callsPerDay) {
      exceededDimensions.push('calls');
    }
    if (parsed.quota.tokensPerMonth !== undefined && parsed.usage.tokensUsed >= parsed.quota.tokensPerMonth) {
      exceededDimensions.push('tokens');
    }
    if (parsed.quota.computeSecondsPerHour !== undefined && parsed.usage.computeSecondsUsed >= parsed.quota.computeSecondsPerHour) {
      exceededDimensions.push('compute');
    }

    if (exceededDimensions.length === 0) {
      return { allowed: true, reason: 'Within budget', headers: {} };
    }

    const retryCandidates: number[] = [];
    if (exceededDimensions.includes('calls')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcDay(parsed.now).getTime() - parsed.now.getTime()) / 1000)));
    }
    if (exceededDimensions.includes('tokens')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcMonth(parsed.now).getTime() - parsed.now.getTime()) / 1000)));
    }
    if (exceededDimensions.includes('compute')) {
      retryCandidates.push(Math.max(1, Math.ceil((toNextUtcHour(parsed.now).getTime() - parsed.now.getTime()) / 1000)));
    }

    const retryAfterSeconds = Math.min(...retryCandidates);
    return {
      allowed: false,
      statusCode: 429,
      reason: `Budget exceeded for org ${parsed.orgId}: ${exceededDimensions.join(', ')}`,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    };
  }
}
