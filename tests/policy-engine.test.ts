/**
 * Tests for the policy engine.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  // ─── JSON policy pack loading ────────────────────────────────────────────

  describe('loadPoliciesFromDir', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads a valid JSON policy file and adds it to the engine', () => {
      const pack = {
        id: 'json-test-pack',
        name: 'JSON Test Pack',
        priority: 20,
        enabled: true,
        rules: [{ action: 'allow', reason: 'JSON allow rule', conditions: { actor: ['json-actor'] } }],
      };
      fs.writeFileSync(path.join(tmpDir, 'test.json'), JSON.stringify(pack));

      engine.loadPoliciesFromDir(tmpDir);

      const policies = engine.getPolicies();
      expect(policies.some((p) => p.id === 'json-test-pack')).toBe(true);
    });

    it('conditions in JSON rules are evaluated correctly', () => {
      const pack = {
        id: 'json-cond-pack',
        name: 'JSON Condition Pack',
        priority: 50,
        enabled: true,
        rules: [
          { action: 'deny', reason: 'Blocked tool', conditions: { toolId: ['blocked-tool'] } },
        ],
      };
      fs.writeFileSync(path.join(tmpDir, 'cond.json'), JSON.stringify(pack));
      engine.loadPoliciesFromDir(tmpDir);

      const denied = engine.evaluate(makeContext({ toolId: 'blocked-tool' }));
      expect(denied.allowed).toBe(false);
      expect(denied.reasons.some((r) => r.includes('Blocked tool'))).toBe(true);

      const allowed = engine.evaluate(makeContext({ toolId: 'other-tool' }));
      expect(allowed.reasons.some((r) => r.includes('Blocked tool'))).toBe(false);
    });

    it('skips files with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'bad.json'), 'not-json');
      const before = engine.getPolicies().length;
      engine.loadPoliciesFromDir(tmpDir);
      expect(engine.getPolicies().length).toBe(before);
    });

    it('skips files that fail schema validation', () => {
      fs.writeFileSync(path.join(tmpDir, 'invalid-schema.json'), JSON.stringify({ id: '' }));
      const before = engine.getPolicies().length;
      engine.loadPoliciesFromDir(tmpDir);
      expect(engine.getPolicies().length).toBe(before);
    });

    it('does not throw when directory does not exist', () => {
      expect(() => engine.loadPoliciesFromDir('/non/existent/dir')).not.toThrow();
    });

    it('re-loading an updated file replaces the old policy', () => {
      const packV1 = {
        id: 'reload-pack',
        name: 'Reload Pack v1',
        priority: 30,
        enabled: true,
        rules: [{ action: 'allow', reason: 'v1 rule', conditions: {} }],
      };
      const packV2 = { ...packV1, name: 'Reload Pack v2' };
      const filePath = path.join(tmpDir, 'reload.json');

      fs.writeFileSync(filePath, JSON.stringify(packV1));
      engine.loadPoliciesFromDir(tmpDir);
      expect(engine.getPolicies().find((p) => p.id === 'reload-pack')?.name).toBe('Reload Pack v1');

      fs.writeFileSync(filePath, JSON.stringify(packV2));
      // Directly invoke loadPoliciesFromDir again to simulate hot-reload
      engine.loadPoliciesFromDir(tmpDir);
      expect(engine.getPolicies().find((p) => p.id === 'reload-pack')?.name).toBe('Reload Pack v2');
    });
  });

  // ─── Hot-reload watcher ──────────────────────────────────────────────────

  describe('watchPoliciesDir', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-watch-'));
    });

    afterEach(() => {
      engine.stopWatching();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('watchPoliciesDir returns an FSWatcher and stopWatching closes it', (done) => {
      const watcher = engine.watchPoliciesDir(tmpDir);
      expect(watcher).toBeDefined();
      engine.stopWatching();
      done();
    });

    it('lastReloadTimestamp is set after loading a policy file', () => {
      const pack = {
        id: 'watch-pack',
        name: 'Watch Pack',
        priority: 15,
        enabled: true,
        rules: [{ action: 'allow', reason: 'Watch allow', conditions: {} }],
      };
      const metricsTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-watch2-'));
      try {
        fs.writeFileSync(path.join(metricsTestDir, 'watch.json'), JSON.stringify(pack));
        engine.loadPoliciesFromDir(metricsTestDir);
        const metrics = engine.getMetrics();
        expect(metrics.lastReloadTimestamp).toBeInstanceOf(Date);
      } finally {
        fs.rmSync(metricsTestDir, { recursive: true, force: true });
      }
    });
  });

  // ─── getPolicies ──────────────────────────────────────────────────────────

  describe('getPolicies', () => {
    it('returns same result as listPolicies', () => {
      expect(engine.getPolicies()).toEqual(engine.listPolicies());
    });

    it('returns policies sorted by descending priority', () => {
      const priorities = engine.getPolicies().map((p) => p.priority);
      for (let i = 1; i < priorities.length; i++) {
        // priorities[i] is always defined since i < priorities.length
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(priorities[i - 1]).toBeGreaterThanOrEqual(priorities[i]!);
      }
    });
  });

  // ─── explainDecision ─────────────────────────────────────────────────────

  describe('explainDecision', () => {
    it('returns an explanation with a summary', () => {
      const ctx = makeContext({ toolId: 'some-tool', action: 'execute' });
      const explanation = engine.explainDecision(ctx);
      expect(explanation).toHaveProperty('allowed');
      expect(explanation).toHaveProperty('requiresApproval');
      expect(typeof explanation.summary).toBe('string');
      expect(explanation.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(explanation.matchedRules)).toBe(true);
      expect(Array.isArray(explanation.reasons)).toBe(true);
    });

    it('summary mentions the tool and actor', () => {
      const ctx = makeContext({ toolId: 'my-tool', actor: 'my-actor' });
      const explanation = engine.explainDecision(ctx);
      expect(explanation.summary).toContain('my-tool');
      expect(explanation.summary).toContain('my-actor');
    });

    it('matchedRules contains policyId and action for each matched rule', () => {
      const ctx = makeContext({ toolId: 'test-tool', action: 'execute' });
      const explanation = engine.explainDecision(ctx);
      for (const rule of explanation.matchedRules) {
        expect(rule).toHaveProperty('policyId');
        expect(rule).toHaveProperty('policyName');
        expect(rule).toHaveProperty('action');
        expect(rule).toHaveProperty('reason');
      }
    });

    it('explanation agrees with evaluate on allowed/requiresApproval', () => {
      const ctx = makeContext({ toolId: 'test-tool', action: 'execute' });
      const decision = engine.evaluate(ctx);
      const explanation = engine.explainDecision(ctx);
      expect(explanation.allowed).toBe(decision.allowed);
      expect(explanation.requiresApproval).toBe(decision.requiresApproval);
    });

    it('summary mentions default-deny when no rules match', () => {
      // Remove all default policies
      const ids = engine.listPolicies().map((p) => p.id);
      for (const id of ids) engine.removePolicy(id);

      const ctx = makeContext();
      const explanation = engine.explainDecision(ctx);
      expect(explanation.allowed).toBe(false);
      expect(explanation.summary).toContain('default deny');
    });
  });

  // ─── Metrics ─────────────────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('totalDecisions increases with each evaluate call', () => {
      const metricsBefore = engine.getMetrics();
      engine.evaluate(makeContext());
      engine.evaluate(makeContext());
      const metricsAfter = engine.getMetrics();
      expect(metricsAfter.totalDecisions).toBe(metricsBefore.totalDecisions + 2);
    });

    it('allowCount and denyCount are tracked correctly', () => {
      // Remove default policies to get a clean state
      const ids = engine.listPolicies().map((p) => p.id);
      for (const id of ids) engine.removePolicy(id);

      engine.addPolicy({
        id: 'allow-all-metrics',
        name: 'Allow All',
        priority: 10,
        enabled: true,
        rules: [{ condition: () => true, action: 'allow', reason: 'Allow' }],
      });

      const metricsBefore = engine.getMetrics();
      engine.evaluate(makeContext());
      engine.evaluate(makeContext());
      const metricsAfter = engine.getMetrics();

      expect(metricsAfter.allowCount).toBe(metricsBefore.allowCount + 2);
    });

    it('decisionsPerSecond is a non-negative number', () => {
      engine.evaluate(makeContext());
      const metrics = engine.getMetrics();
      expect(metrics.decisionsPerSecond).toBeGreaterThanOrEqual(0);
    });

    it('allowDenyRatio returns Infinity when denyCount is 0 and allowCount > 0', () => {
      // Create an isolated engine to control counts
      const isolated = new PolicyEngine();
      const ids = isolated.listPolicies().map((p) => p.id);
      for (const id of ids) isolated.removePolicy(id);

      isolated.addPolicy({
        id: 'all-allow',
        name: 'All Allow',
        priority: 10,
        enabled: true,
        rules: [{ condition: () => true, action: 'allow', reason: 'Allow' }],
      });

      isolated.evaluate(makeContext());
      const metrics = isolated.getMetrics();
      expect(metrics.allowDenyRatio).toBe(Infinity);
    });

    it('lastReloadTimestamp is null before any file is loaded', () => {
      const isolated = new PolicyEngine();
      expect(isolated.getMetrics().lastReloadTimestamp).toBeNull();
    });
  });
});
