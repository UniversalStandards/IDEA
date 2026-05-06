import fs from 'fs';
import os from 'os';
import path from 'path';
import { RbacEngine } from '../src/policy/rbac/RbacEngine';
import { AbacEngine, PolicyStore } from '../src/policy/abac/AbacEngine';
import { CsaTrustFramework, CsaTrustLevel } from '../src/policy/csa/CsaTrustFramework';
import { TrustLevelEvaluator } from '../src/policy/csa/TrustLevelEvaluator';
import { RateLimiter } from '../src/policy/limits/RateLimiter';
import { QuotaManager } from '../src/policy/limits/QuotaManager';
import { PolicyAuditLog } from '../src/policy/audit/PolicyAuditLog';
import { PolicyEngine } from '../src/policy/policy-engine';

describe('Policy governance modules', () => {
  it('RBAC resolves inherited permissions and caches results quickly', () => {
    const rbac = new RbacEngine([
      { name: 'intern', permissions: ['read:*'], inherits: [] },
      { name: 'assistant', permissions: ['tool:execute:approved'], inherits: ['intern'] },
      { name: 'expert', permissions: ['tool:execute:*'], inherits: ['assistant'] },
    ]);

    rbac.assignRole('org-1', 'user-1', 'expert');

    const first = rbac.resolvePermissions('org-1', 'user-1');
    const start = process.hrtime.bigint();
    const second = rbac.resolvePermissions('org-1', 'user-1');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(first.has('read:*')).toBe(true);
    expect(first.has('tool:execute:approved')).toBe(true);
    expect(second.has('tool:execute:*')).toBe(true);
    expect(elapsedMs).toBeLessThan(5);
  });

  it('ABAC evaluates org policy loaded from policies/{orgId}/policy.yaml', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abac-policy-'));
    const orgDir = path.join(baseDir, 'org-1');
    fs.mkdirSync(orgDir, { recursive: true });

    fs.writeFileSync(
      path.join(orgDir, 'policy.yaml'),
      [
        'version: "1"',
        'defaultEffect: deny',
        'rules:',
        '  - id: engineering-read',
        '    effect: allow',
        '    actions:',
        '      - read',
        '    resources:',
        '      - document',
        '    condition:',
        '      op: eq',
        '      path: subject.department',
        '      value: engineering',
      ].join('\n'),
      'utf8',
    );

    const abac = new AbacEngine(new PolicyStore(baseDir));

    const allow = abac.evaluate({
      orgId: 'org-1',
      action: 'read',
      resource: { id: 'doc-1', type: 'document', attributes: {} },
      subject: { id: 'u1', roles: ['intern'], attributes: { department: 'engineering' } },
      environment: {},
      request: {},
    });

    const deny = abac.evaluate({
      orgId: 'org-1',
      action: 'read',
      resource: { id: 'doc-1', type: 'document', attributes: {} },
      subject: { id: 'u2', roles: ['intern'], attributes: { department: 'finance' } },
      environment: {},
      request: {},
    });

    expect(allow.allowed).toBe(true);
    expect(deny.allowed).toBe(false);
  });

  it('CSA framework enforces transition rules and evaluator assigns level', () => {
    const framework = new CsaTrustFramework();
    const evaluator = new TrustLevelEvaluator(framework);

    const blockedTransition = framework.canTransition(CsaTrustLevel.Assistant, CsaTrustLevel.Expert, {
      hasToolExecutionPermission: true,
      sensitiveOperationsApproved: true,
      completedSecurityTraining: true,
      orgApprovalGranted: true,
    });

    const result = evaluator.evaluate({
      role: 'engineer',
      permissions: ['tool:execute:*'],
      context: {
        crossToolWorkflowCount: 4,
        sensitiveActionApprovalRate: 0.98,
        completedSecurityTraining: true,
        delegationAllowed: true,
        orgApprovalGranted: true,
      },
      history: {
        incidentsLast90Days: 0,
        successfulRunsLast30Days: 40,
      },
    });

    expect(blockedTransition).toBe(false);
    expect(result.level).toBe(CsaTrustLevel.Principal);
  });

  it('RateLimiter enforces sliding window and QuotaManager emits quota.exceeded', async () => {
    const limiter = new RateLimiter();
    const first = await limiter.check(
      { orgId: 'org-1', userId: 'user-1', role: 'assistant' },
      { windowMs: 1_000, maxRequests: 1 },
    );
    const second = await limiter.check(
      { orgId: 'org-1', userId: 'user-1', role: 'assistant' },
      { windowMs: 1_000, maxRequests: 1 },
    );

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);

    const quotas = new QuotaManager();
    quotas.configureOrg('org-1', { callsPerDay: 1 });

    const exceededEvents: Array<{ orgId: string; reason: string }> = [];
    quotas.on('quota.exceeded', (event) => {
      exceededEvents.push({ orgId: String(event.orgId), reason: String(event.reason) });
    });

    const allow = quotas.consume('org-1', { calls: 1, tokens: 0, computeSeconds: 0 });
    const deny = quotas.consume('org-1', { calls: 1, tokens: 0, computeSeconds: 0 });

    expect(allow.allowed).toBe(true);
    expect(deny.allowed).toBe(false);
    expect(exceededEvents.length).toBe(1);
  });

  it('PolicyAuditLog appends decisions and policy engine evaluates governance with per-org policy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-engine-'));
    const orgDir = path.join(tmp, 'org-7');
    fs.mkdirSync(orgDir, { recursive: true });

    fs.writeFileSync(
      path.join(orgDir, 'policy.yaml'),
      [
        'version: "1"',
        'defaultEffect: deny',
        'rules:',
        '  - id: execute-approved',
        '    effect: allow',
        '    actions:',
        '      - execute',
        '    resources:',
        '      - tool',
      ].join('\n'),
      'utf8',
    );

    const auditPath = path.join(tmp, 'policy-audit.jsonl');
    const auditLog = new PolicyAuditLog(auditPath);
    auditLog.append({
      orgId: 'org-7',
      actor: 'user-7',
      action: 'policy.test',
      resource: 'tool:calculator',
      decision: 'allow',
      reason: 'test entry',
      metadata: {},
    });

    const entries = auditLog.list({ orgId: 'org-7', limit: 10, offset: 0 });
    expect(entries.length).toBe(1);

    const engine = new PolicyEngine(tmp);
    engine.getRbacEngine().assignRole('org-7', 'user-7', 'assistant');

    const decision = await engine.evaluateGovernance({
      orgId: 'org-7',
      userId: 'user-7',
      action: 'execute',
      resource: { id: 'calculator', type: 'tool' },
      subjectAttributes: {
        completedSecurityTraining: true,
        orgApprovalGranted: false,
        incidentsLast90Days: 0,
        successfulRunsLast30Days: 10,
      },
      request: {
        crossToolWorkflowCount: 1,
        sensitiveActionApprovalRate: 0.95,
      },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.permissions).toContain('tool:execute:approved');
  });
});
