/**
 * tests/logger.test.ts
 * Regression coverage for the log redaction format. The original implementation
 * rebuilt winston's `info` object and dropped its Symbol keys, which crashed
 * `format.colorize()` on the first log line in every non-production run.
 */

import { format } from 'winston';
import { redactFormat, redactSensitive } from '../src/observability/logger';

// winston's well-known Symbol keys (triple-beam is only a transitive dependency).
const LEVEL = Symbol.for('level');
const MESSAGE = Symbol.for('message');

describe('redactSensitive()', () => {
  it('redacts sensitive keys at any depth, case-insensitively', () => {
    const out = redactSensitive({
      user: 'alice',
      Password: 'hunter2',
      nested: { apiKey: 'abc', list: [{ token: 't', ok: 1 }] },
    });

    expect(out).toEqual({
      user: 'alice',
      Password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', list: [{ token: '[REDACTED]', ok: 1 }] },
    });
  });

  it('returns primitives and null unchanged', () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive('x')).toBe('x');
    expect(redactSensitive(5)).toBe(5);
  });

  it('preserves Error name/message/stack while redacting enumerable secrets', () => {
    const err = Object.assign(new Error('request failed'), {
      token: 'abc',
      config: { headers: { Authorization: 'Bearer ghp_secret' }, url: '/x' },
    });

    const out = redactSensitive(err) as Record<string, unknown>;

    expect(out['name']).toBe('Error');
    expect(out['message']).toBe('request failed');
    expect(typeof out['stack']).toBe('string');
    expect(out['token']).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('ghp_secret');
    expect((out['config'] as { url: string }).url).toBe('/x');
  });

  it('redacts secrets inside an Error cause', () => {
    const err = new Error('outer', { cause: { password: 'p', detail: 'd' } });

    const out = redactSensitive(err) as { cause: Record<string, unknown> };

    expect(out.cause).toEqual({ password: '[REDACTED]', detail: 'd' });
  });

  it('fails closed past the depth limit: nested secrets never appear', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 15; i++) {
      const next: Record<string, unknown> = {};
      cursor['n'] = next;
      cursor = next;
    }
    cursor['password'] = 'deep-secret-value';

    const out = redactSensitive(deep);

    expect(JSON.stringify(out)).not.toContain('deep-secret-value');
    expect(JSON.stringify(out)).toContain('[TRUNCATED]');
  });
});

describe('redactFormat()', () => {
  it('preserves winston Symbol keys while redacting string keys', () => {
    const info = {
      level: 'info',
      message: 'login',
      password: 'p',
      [LEVEL]: 'info',
      [MESSAGE]: 'login',
    };

    const result = redactFormat().transform(info) as typeof info;

    expect(result.password).toBe('[REDACTED]');
    expect(result[LEVEL]).toBe('info');
    expect(result[MESSAGE]).toBe('login');
  });

  it('does not crash format.colorize() downstream (regression)', () => {
    const pipeline = format.combine(redactFormat(), format.colorize());

    const out = pipeline.transform({
      level: 'warn',
      message: 'careful',
      [LEVEL]: 'warn',
    }) as Record<string, unknown>;

    expect(typeof out['level']).toBe('string');
    expect(out['level']).toContain('warn');
  });

  it('keeps Error message readable and redacts its secrets after the format runs', () => {
    const err = Object.assign(new Error('kaput'), { apiKey: 'k' });
    const info = { level: 'error', message: 'failed', err, [LEVEL]: 'error' };

    const result = redactFormat().transform(info) as unknown as { err: Record<string, unknown> };

    expect(result.err['message']).toBe('kaput');
    expect(result.err['apiKey']).toBe('[REDACTED]');
  });
});
