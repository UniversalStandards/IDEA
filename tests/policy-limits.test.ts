import fs from 'fs';
import os from 'os';
import path from 'path';
import { PolicyAuditLog } from '../src/policy/audit/PolicyAuditLog';
import { BudgetEnforcer } from '../src/policy/limits/BudgetEnforcer';
import { OrgQuotaConfigStore } from '../src/policy/limits/QuotaConfig';
import { QuotaManager } from '../src/policy/limits/QuotaManager';
import { QuotaResetScheduler } from '../src/policy/limits/QuotaResetScheduler';
import { QuotaStore } from '../src/policy/limits/QuotaStore';
import { RateLimiter } from '../src/policy/limits/RateLimiter';

describe('Policy limits', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads per-org rate limit from policies/{orgId}/quota.yaml with user/org/role scoping', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-limits-'));
    tmpDirs.push(baseDir);
    const orgDir = path.join(baseDir, 'org-1');
    fs.mkdirSync(orgDir, { recursive: true });

    fs.writeFileSync(
      path.join(orgDir, 'quota.yaml'),
      ['rateLimit:', '  requests:', '    windowSeconds: 60', '    maxRequests: 1'].join('\n'),
      'utf8',
    );

    const limiter = new RateLimiter(undefined, new OrgQuotaConfigStore(baseDir));
    const first = await limiter.checkForOrg({ orgId: 'org-1', userId: 'user-1', role: 'assistant' });
    const second = await limiter.checkForOrg({ orgId: 'org-1', userId: 'user-1', role: 'assistant' });
    const otherRole = await limiter.checkForOrg({ orgId: 'org-1', userId: 'user-1', role: 'expert' });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(otherRole.allowed).toBe(true);
  });

  it('emits quota.warning at 80% and quota.exceeded at 100% with Retry-After', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-quotas-'));
    tmpDirs.push(baseDir);
    const orgDir = path.join(baseDir, 'org-7');
    fs.mkdirSync(orgDir, { recursive: true });

    fs.writeFileSync(
      path.join(orgDir, 'quota.yaml'),
      [
        'quota:',
        '  day:',
        '    apiCalls: 5',
        '  month:',
        '    tokens: 10',
        '  hour:',
        '    computeSeconds: 10',
        '  alertThresholds:',
        '    - 0.8',
        '    - 1.0',
      ].join('\n'),
      'utf8',
    );

    const store = new QuotaStore(path.join(baseDir, 'quota.sqlite'));
    const manager = new QuotaManager(store, new OrgQuotaConfigStore(baseDir));
    const warnings: unknown[] = [];
    const exceeded: unknown[] = [];

    manager.on('quota.warning', (event) => warnings.push(event));
    manager.on('quota.exceeded', (event) => exceeded.push(event));

    const nearLimit = manager.consume('org-7', { calls: 4, tokens: 0, computeSeconds: 0 }, new Date('2026-05-30T10:00:00.000Z'));
    const blocked = manager.consume('org-7', { calls: 1, tokens: 0, computeSeconds: 0 }, new Date('2026-05-30T10:00:01.000Z'));

    expect(nearLimit.allowed).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers?.['Retry-After']).toBeDefined();
    expect(exceeded.length).toBe(1);
  });

  it('BudgetEnforcer returns 429 and Retry-After when budget is exhausted', () => {
    const enforcer = new BudgetEnforcer();
    const result = enforcer.enforce({
      orgId: 'org-budget',
      now: new Date('2026-05-30T12:30:00.000Z'),
      usage: { callsUsed: 100, tokensUsed: 1, computeSecondsUsed: 1 },
      quota: { callsPerDay: 100, alertThresholds: [0.8, 1.0] },
    });

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.headers['Retry-After']).toBeDefined();
  });

  it('QuotaResetScheduler resets counters at billing boundaries and logs audit events', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-reset-'));
    tmpDirs.push(baseDir);

    const quotaStore = new QuotaStore(path.join(baseDir, 'quota.sqlite'));
    quotaStore.saveUsage('org-9', {
      dayBucket: '2026-05-31',
      monthBucket: '2026-05',
      hourBucket: '2026-05-31T23',
      callsUsed: 7,
      tokensUsed: 99,
      computeSecondsUsed: 42,
    });

    const auditLog = new PolicyAuditLog(path.join(baseDir, 'policy-audit.jsonl'));
    const scheduler = new QuotaResetScheduler(quotaStore, auditLog);
    scheduler.runPendingResets(new Date('2026-05-31T23:59:59.000Z'));
    scheduler.runPendingResets(new Date('2026-06-01T00:00:01.000Z'));

    const updated = quotaStore.loadUsage('org-9');
    expect(updated?.monthBucket).toBe('2026-06');
    expect(updated?.dayBucket).toBe('2026-06-01');
    expect(updated?.hourBucket).toBe('2026-06-01T00');
    expect(updated?.tokensUsed).toBe(0);
    expect(updated?.callsUsed).toBe(0);
    expect(updated?.computeSecondsUsed).toBe(0);

    const resetEntries = auditLog.list({ limit: 20 }).filter((entry) => entry.action.startsWith('policy.quota.reset.'));
    expect(resetEntries.length).toBeGreaterThan(0);
  });
});
