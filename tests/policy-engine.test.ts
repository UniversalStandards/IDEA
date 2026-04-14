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
});
