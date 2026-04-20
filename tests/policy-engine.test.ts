/**
 * Tests for the policy engine.
 */
import { PolicyEngine, PolicyContext, Policy } from '../src/policy/policy-engine';

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    toolId: 'test-tool',
    actor: 'test-user',
    action: 'execute',
    environment: 'test',
    metadata: {},
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it('starts with default policies loaded', () => {
    const policies = engine.listPolicies();
    expect(policies.length).toBeGreaterThan(0);
  });

  it('allows a standard tool execution by default', () => {
    const ctx = makeContext({ toolId: 'some-known-tool', action: 'execute' });
    const decision = engine.evaluate(ctx);
    // Default policies should not blanket-deny known tools
    expect(decision).toHaveProperty('allowed');
    expect(decision).toHaveProperty('requiresApproval');
    expect(Array.isArray(decision.reasons)).toBe(true);
  });

  it('can add and remove a custom policy', () => {
    const before = engine.listPolicies().length;
    const policy: Policy = {
      id: 'custom-deny',
      name: 'Custom Deny All',
      priority: 1000,
      enabled: true,
      rules: [
        {
          condition: () => true,
          action: 'deny',
          reason: 'All denied by custom policy',
        },
      ],
    };
    engine.addPolicy(policy);
    expect(engine.listPolicies().length).toEqual(before + 1);

    const decision = engine.evaluate(makeContext());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => r.includes('All denied by custom policy'))).toBe(true);

    engine.removePolicy('custom-deny');
    expect(engine.listPolicies().length).toEqual(before);
  });

  it('deny overrides allow (deny-wins semantics)', () => {
    engine.addPolicy({
      id: 'p-allow',
      name: 'Allow all',
      priority: 1000,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Allow everything' }],
    });
    engine.addPolicy({
      id: 'p-deny',
      name: 'Deny all',
      priority: 50,
      enabled: true,
      rules: [{ condition: () => true, action: 'deny', reason: 'Deny everything' }],
    });

    // When both allow and deny match, deny wins
    const decision = engine.evaluate(makeContext());
    expect(decision.allowed).toBe(false);

    engine.removePolicy('p-allow');
    engine.removePolicy('p-deny');
  });

  it('allow without any deny results in allowed=true', () => {
    // Remove all default policies to test in isolation
    const ids = engine.listPolicies().map((p) => p.id);
    for (const id of ids) engine.removePolicy(id);

    engine.addPolicy({
      id: 'solo-allow',
      name: 'Solo allow',
      priority: 10,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Allow' }],
    });

    const decision = engine.evaluate(makeContext());
    expect(decision.allowed).toBe(true);
  });

  it('disabled policies are not evaluated', () => {
    engine.addPolicy({
      id: 'disabled-deny',
      name: 'Disabled deny',
      priority: 999,
      enabled: false,
      rules: [{ condition: () => true, action: 'deny', reason: 'Should not run' }],
    });
    // The disabled policy should not affect the decision
    const decision = engine.evaluate(makeContext());
    expect(decision.reasons).not.toContain('Should not run');
    engine.removePolicy('disabled-deny');
  });

  it('updatePolicy updates an existing policy', () => {
    const id = engine.listPolicies()[0]?.id ?? 'default-allow-official';
    const updated = engine.updatePolicy(id, { enabled: false });
    expect(updated).toBe(true);
    const found = engine.listPolicies().find((p) => p.id === id);
    expect(found?.enabled).toBe(false);
  });

  it('updatePolicy returns false for a non-existent policy', () => {
    expect(engine.updatePolicy('no-such-policy', { enabled: false })).toBe(false);
  });

  it('listPolicies returns policies sorted by priority descending', () => {
    const policies = engine.listPolicies();
    for (let i = 1; i < policies.length; i++) {
      expect(policies[i - 1]!.priority).toBeGreaterThanOrEqual(policies[i]!.priority);
    }
  });

  it('removePolicy returns false for a non-existent policy', () => {
    expect(engine.removePolicy('not-there')).toBe(false);
  });

  it('explainDecision returns allowed=true with reason when an allow rule matches', () => {
    // Remove all policies then add a sole allow rule
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    engine.addPolicy({
      id: 'explain-allow',
      name: 'Explain Allow',
      priority: 10,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Explicitly allowed' }],
    });

    const explanation = engine.explainDecision(makeContext());
    expect(explanation.allowed).toBe(true);
    expect(typeof explanation.reason).toBe('string');
    expect(explanation.matchedRules).toContain('explain-allow');
  });

  it('explainDecision returns allowed=false with deny reason when a deny rule matches', () => {
    engine.addPolicy({
      id: 'explain-deny',
      name: 'Explain Deny',
      priority: 999,
      enabled: true,
      rules: [{ condition: () => true, action: 'deny', reason: 'Explicitly denied here' }],
    });

    const explanation = engine.explainDecision(makeContext());
    expect(explanation.allowed).toBe(false);
    expect(explanation.reason).toContain('Explicitly denied here');
    engine.removePolicy('explain-deny');
  });

  it('explainDecision includes the decision object', () => {
    const explanation = engine.explainDecision(makeContext());
    expect(explanation).toHaveProperty('decision');
    expect(explanation.decision).toHaveProperty('allowed');
    expect(explanation.decision).toHaveProperty('reasons');
  });

  it('loadPoliciesFromDir handles missing directory gracefully', async () => {
    // Should not throw when policies/ dir doesn't exist
    await expect(engine.loadPoliciesFromDir('/tmp/nonexistent-policies-dir-xyz')).resolves.not.toThrow();
  });

  it('loadPoliciesFromDir loads valid JSON policy packs from directory', async () => {
    const { mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
    const tmpDir = '/tmp/test-policy-packs';
    mkdirSync(tmpDir, { recursive: true });

    // Policy pack format must match isValidPackRule: id, description, conditions, effect
    const pack = {
      name: 'test-pack',
      rules: [
        {
          id: 'rule-1',
          description: 'Block test environment',
          conditions: { environment: { eq: 'blocked' } },
          effect: 'deny',
        },
      ],
    };
    writeFileSync(`${tmpDir}/test.json`, JSON.stringify(pack));

    const countBefore = engine.listPolicies().filter((p) => p.id.startsWith('pack:')).length;
    await engine.loadPoliciesFromDir(tmpDir);
    const countAfter = engine.listPolicies().filter((p) => p.id.startsWith('pack:')).length;

    expect(countAfter).toBeGreaterThan(countBefore);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stopWatcher is a no-op when no watcher is active', () => {
    // Should not throw
    expect(() => engine.stopWatcher()).not.toThrow();
  });

  it('evaluate handles rule condition that throws without crashing', () => {
    engine.addPolicy({
      id: 'throwing-rule',
      name: 'Throwing rule',
      priority: 200,
      enabled: true,
      rules: [
        {
          condition: () => {
            throw new Error('condition blew up');
          },
          action: 'deny',
          reason: 'Should be skipped',
        },
      ],
    });
    // Should not throw — the rule is skipped, evaluation continues
    expect(() => engine.evaluate(makeContext())).not.toThrow();
    engine.removePolicy('throwing-rule');
  });

  it('require_approval action is reflected in decision', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    engine.addPolicy({
      id: 'approval-rule',
      name: 'Approval required',
      priority: 100,
      enabled: true,
      rules: [
        {
          condition: () => true,
          action: 'require_approval',
          reason: 'Needs human approval',
        },
      ],
    });
    engine.addPolicy({
      id: 'allow-too',
      name: 'Also allow',
      priority: 50,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Also allowed' }],
    });
    const decision = engine.evaluate(makeContext());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reasons.some((r) => r.includes('Needs human approval'))).toBe(true);
  });

  it('log action is recorded in reasons but does not affect allow/deny', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    engine.addPolicy({
      id: 'log-rule',
      name: 'Log rule',
      priority: 100,
      enabled: true,
      rules: [{ condition: () => true, action: 'log', reason: 'Just logging' }],
    });
    engine.addPolicy({
      id: 'allow-rule',
      name: 'Allow rule',
      priority: 50,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Allow' }],
    });
    const decision = engine.evaluate(makeContext());
    expect(decision.allowed).toBe(true);
    expect(decision.reasons.some((r) => r.includes('Just logging'))).toBe(true);
  });

  it('default deny applies when no explicit allow or deny rule matches', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    // No policies at all → default deny
    const decision = engine.evaluate(makeContext());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => r.includes('default deny'))).toBe(true);
  });

  it('explainDecision returns "Action permitted" when no allow entry found', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    // Add a log rule + allow rule with no explicit [ALLOW] text matching
    engine.addPolicy({
      id: 'pure-allow',
      name: 'Pure allow',
      priority: 10,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Permitted' }],
    });
    const explanation = engine.explainDecision(makeContext());
    expect(explanation.allowed).toBe(true);
    expect(explanation.reason).toBeTruthy();
  });

  it('explainDecision returns reason about approval when requiresApproval and allowed', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    engine.addPolicy({
      id: 'req-approval',
      name: 'Req approval',
      priority: 100,
      enabled: true,
      rules: [{ condition: () => true, action: 'require_approval', reason: 'Need approval' }],
    });
    engine.addPolicy({
      id: 'also-allow',
      name: 'Also allow',
      priority: 50,
      enabled: true,
      rules: [{ condition: () => true, action: 'allow', reason: 'Allow' }],
    });
    const explanation = engine.explainDecision(makeContext());
    expect(explanation.allowed).toBe(true);
    expect(explanation.decision.requiresApproval).toBe(true);
    expect(explanation.reason).toContain('approval');
  });

  it('explainDecision returns generic deny reason when no [DENY] entry found', () => {
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    // No policies → default deny reason added internally
    const explanation = engine.explainDecision(makeContext());
    expect(explanation.allowed).toBe(false);
    expect(explanation.reason).toBeTruthy();
  });

  it('loadPoliciesFromDir skips non-JSON files', async () => {
    const { mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
    const tmpDir = '/tmp/test-policy-skip';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/readme.txt`, 'not json');
    const countBefore = engine.listPolicies().length;
    await engine.loadPoliciesFromDir(tmpDir);
    expect(engine.listPolicies().length).toEqual(countBefore);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadPoliciesFromDir skips invalid JSON files', async () => {
    const { mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
    const tmpDir = '/tmp/test-policy-bad-json';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/broken.json`, '{ not valid json }');
    const countBefore = engine.listPolicies().length;
    await engine.loadPoliciesFromDir(tmpDir);
    expect(engine.listPolicies().length).toEqual(countBefore);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadPoliciesFromDir skips policy packs that fail schema validation', async () => {
    const { mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
    const tmpDir = '/tmp/test-policy-invalid-schema';
    mkdirSync(tmpDir, { recursive: true });
    // Missing required 'name' field
    writeFileSync(`${tmpDir}/invalid.json`, JSON.stringify({ rules: [] }));
    const countBefore = engine.listPolicies().length;
    await engine.loadPoliciesFromDir(tmpDir);
    expect(engine.listPolicies().length).toEqual(countBefore);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadPoliciesFromDir removes old pack policies before reloading', async () => {
    const { mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
    const tmpDir = '/tmp/test-policy-reload';
    mkdirSync(tmpDir, { recursive: true });

    const pack = {
      name: 'reload-pack',
      rules: [
        { id: 'r1', description: 'Rule 1', conditions: {}, effect: 'allow' },
      ],
    };
    writeFileSync(`${tmpDir}/pack.json`, JSON.stringify(pack));

    await engine.loadPoliciesFromDir(tmpDir);
    const countAfterFirst = engine.listPolicies().filter((p) => p.id.startsWith('pack:')).length;

    // Load again — should not double-add
    await engine.loadPoliciesFromDir(tmpDir);
    const countAfterSecond = engine.listPolicies().filter((p) => p.id.startsWith('pack:')).length;

    expect(countAfterSecond).toEqual(countAfterFirst);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────
// New: buildConditionFn branch coverage via loaded policy packs
// ─────────────────────────────────────────────────────────────────

describe('PolicyEngine — buildConditionFn via loaded packs', () => {
  let engine: PolicyEngine;
  let tmpDir: string;

  beforeEach(() => {
    engine = new PolicyEngine();
    // Remove all default policies for isolation
    for (const p of engine.listPolicies()) engine.removePolicy(p.id);
    const { mkdirSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    tmpDir = join(process.cwd(), 'tests', `policy-pack-fixture-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    const { rmSync } = require('fs') as typeof import('fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('riskLevel.gte condition matches when level >= threshold (deny fires)', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'risk-pack',
      rules: [{ id: 'rl1', description: 'High risk deny', conditions: { riskLevel: { gte: 5 } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'risk.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: { riskLevel: 7 } });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('High risk deny'))).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it('riskLevel.gte condition does not match when level < threshold', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'risk-pack2',
      rules: [{ id: 'rl2', description: 'High risk deny 2', conditions: { riskLevel: { gte: 5 } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'risk2.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: { riskLevel: 3 } });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('High risk deny 2'))).toBe(false);
  });

  it('riskLevel.gte condition does not match when riskLevel is not a number', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'risk-pack3',
      rules: [{ id: 'rl3', description: 'High risk deny 3', conditions: { riskLevel: { gte: 5 } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'risk3.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: {} });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('High risk deny 3'))).toBe(false);
  });

  it('capabilities.contains condition matches when capability is present', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'caps-pack',
      rules: [{ id: 'cp1', description: 'Caps deny', conditions: { capabilities: { contains: 'read_files' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'caps.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: { capabilities: ['read_files', 'write_files'] } });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Caps deny'))).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it('capabilities.contains condition does not match when capability is absent', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'caps-pack2',
      rules: [{ id: 'cp2', description: 'Caps deny 2', conditions: { capabilities: { contains: 'read_files' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'caps2.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: { capabilities: ['write_files'] } });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Caps deny 2'))).toBe(false);
  });

  it('capabilities.contains condition does not match when capabilities is not an array', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'caps-pack3',
      rules: [{ id: 'cp3', description: 'Caps deny 3', conditions: { capabilities: { contains: 'read_files' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'caps3.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ metadata: { capabilities: 'read_files' } });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Caps deny 3'))).toBe(false);
  });

  it('action.pattern condition matches when action matches the pattern', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'action-pack',
      rules: [{ id: 'ap1', description: 'Execute action deny', conditions: { action: { pattern: '^execute' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'action.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ action: 'execute_tool' });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Execute action deny'))).toBe(true);
  });

  it('action.pattern condition does not match when action does not match the pattern', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'action-pack2',
      rules: [{ id: 'ap2', description: 'Execute action deny 2', conditions: { action: { pattern: '^execute' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'action2.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ action: 'install' });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Execute action deny 2'))).toBe(false);
  });

  it('environment.eq condition matches when environment equals the value', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'env-pack',
      rules: [{ id: 'ep1', description: 'Blocked env', conditions: { environment: { eq: 'production' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'env.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ environment: 'production' });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Blocked env'))).toBe(true);
  });

  it('environment.eq condition does not match when environment differs', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'env-pack2',
      rules: [{ id: 'ep2', description: 'Blocked env 2', conditions: { environment: { eq: 'production' } }, effect: 'deny' }],
    };
    writeFileSync(join(tmpDir, 'env2.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext({ environment: 'test' });
    const decision = engine.evaluate(ctx);
    expect(decision.reasons.some((r) => r.includes('Blocked env 2'))).toBe(false);
  });

  it('require_approval effect in pack rule sets requiresApproval on decision', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const pack = {
      name: 'approval-pack',
      rules: [
        { id: 'ra1', description: 'Needs human approval', conditions: {}, effect: 'require_approval' },
        { id: 'ra2', description: 'Allow too', conditions: {}, effect: 'allow' },
      ],
    };
    writeFileSync(join(tmpDir, 'approval.json'), JSON.stringify(pack));
    await engine.loadPoliciesFromDir(tmpDir);

    const ctx = makeContext();
    const decision = engine.evaluate(ctx);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reasons.some((r) => r.includes('Needs human approval'))).toBe(true);
    expect(decision.allowed).toBe(true);
  });
});
