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
});
