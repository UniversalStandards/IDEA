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

  it('keeps Error instances intact so message and stack survive', () => {
    const err = new Error('boom');

    expect(redactSensitive(err)).toBe(err);
  });

  it('stops recursing past the depth limit', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 15; i++) {
      const next: Record<string, unknown> = {};
      cursor['n'] = next;
      cursor = next;
    }

    expect(() => redactSensitive(deep)).not.toThrow();
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

  it('leaves Error metadata readable after redaction', () => {
    const err = new Error('kaput');
    const info = { level: 'error', message: 'failed', err, [LEVEL]: 'error' };

    const result = redactFormat().transform(info) as typeof info;

    expect(result.err).toBe(err);
    expect(result.err.message).toBe('kaput');
  });
});
