/**
 * tests/declarative-policy.test.ts
 * Unit tests for src/policy/declarative-policy.ts.
 */

import { compileDeclarativePolicy, PROTECTED_POLICY_IDS } from '../src/policy/declarative-policy';

const ctx = (toolId: string, action: string, actor = 'mcp-client'): Parameters<
  ReturnType<typeof compileDeclarativePolicy>['rules'][number]['condition']
>[0] => ({ toolId, action, actor, environment: 'test' });

describe('compileDeclarativePolicy()', () => {
  it('compiles exact and glob matchers into conditions', () => {
    const policy = compileDeclarativePolicy({
      id: 'p1',
      name: 'Policy one',
      rules: [{ match: { toolId: 'official:*', action: 'read_*' }, action: 'allow', reason: 'reads are fine' }],
    });

    expect(policy).toMatchObject({ id: 'p1', name: 'Policy one', priority: 50, enabled: true });
    const rule = policy.rules[0];
    expect(rule?.action).toBe('allow');
    expect(rule?.condition(ctx('official:memory', 'read_graph'))).toBe(true);
    expect(rule?.condition(ctx('official:memory', 'write_file'))).toBe(false);
    expect(rule?.condition(ctx('github:x', 'read_graph'))).toBe(false);
  });

  it('matches everything when no matcher is given and honors actor', () => {
    const policy = compileDeclarativePolicy({
      id: 'p2',
      name: 'Actor scoped',
      priority: 70,
      enabled: false,
      rules: [
        { match: {}, action: 'log', reason: 'all' },
        { match: { actor: 'agent-*' }, action: 'deny', reason: 'agents' },
      ],
    });
    expect(policy.priority).toBe(70);
    expect(policy.enabled).toBe(false);
    expect(policy.rules[0]?.condition(ctx('a', 'b'))).toBe(true);
    expect(policy.rules[1]?.condition(ctx('a', 'b', 'agent-7'))).toBe(true);
    expect(policy.rules[1]?.condition(ctx('a', 'b', 'human'))).toBe(false);
  });

  it('treats regex metacharacters in patterns literally', () => {
    const policy = compileDeclarativePolicy({
      id: 'p3',
      name: 'Literal dot',
      rules: [{ match: { toolId: 'a.b' }, action: 'allow', reason: 'r' }],
    });
    expect(policy.rules[0]?.condition(ctx('a.b', 'x'))).toBe(true);
    expect(policy.rules[0]?.condition(ctx('axb', 'x'))).toBe(false);
  });

  it.each([...PROTECTED_POLICY_IDS])('refuses to replace protected policy %s', (id) => {
    expect(() =>
      compileDeclarativePolicy({ id, name: 'x', rules: [{ match: {}, action: 'allow', reason: 'r' }] }),
    ).toThrow('protected built-in policy');
  });

  it.each([
    [{ name: 'no id', rules: [{ match: {}, action: 'allow', reason: 'r' }] }],
    [{ id: 'x', name: 'no rules', rules: [] }],
    [{ id: 'x y', name: 'bad id', rules: [{ match: {}, action: 'allow', reason: 'r' }] }],
    [{ id: 'x', name: 'bad action', rules: [{ match: {}, action: 'explode', reason: 'r' }] }],
    [{ id: 'x', name: 'bad pattern', rules: [{ match: { toolId: '$(rm)' }, action: 'allow', reason: 'r' }] }],
    [{ id: 'x', name: 'unknown matcher', rules: [{ match: { condition: 'x' }, action: 'allow', reason: 'r' }] }],
    [{ id: 'x', name: 'priority', priority: 5000, rules: [{ match: {}, action: 'allow', reason: 'r' }] }],
  ])('rejects invalid input %#', (input) => {
    expect(() => compileDeclarativePolicy(input)).toThrow();
  });
});
