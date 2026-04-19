/**
 * tests/logger.test.ts
 * Tests for src/observability/logger.ts
 * Tests the exported factories and the redactSensitive utility
 * (exported explicitly for testing via the @internal annotation).
 */

// Must set env before importing the module
process.env['NODE_ENV'] = 'test';

// Mock winston so we don't create real transports or log files
jest.mock('winston', () => {
  const actualWinston = jest.requireActual<typeof import('winston')>('winston');

  const childLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn(),
    child: jest.fn(),
  };
  // child() should return another child-logger-like object
  childLogger.child = jest.fn().mockReturnValue(childLogger);

  const mockLogger = {
    ...childLogger,
    level: 'debug',
    silent: true,
    child: jest.fn().mockReturnValue(childLogger),
  };

  return {
    ...actualWinston,
    createLogger: jest.fn().mockReturnValue(mockLogger),
    format: actualWinston.format,
    transports: {
      Console: jest.fn().mockImplementation(() => ({})),
    },
  };
});

// Mock DailyRotateFile transport — it would try to write to disk
jest.mock('winston-daily-rotate-file', () => jest.fn().mockImplementation(() => ({})));

// Mock fs to avoid actual directory creation calls
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
}));

import { createLogger, createRequestLogger, redactSensitive, rootLogger } from '../src/observability/logger';

describe('createLogger', () => {
  it('returns an object with standard log methods', () => {
    const logger = createLogger('test-module');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('calling log methods does not throw', () => {
    const logger = createLogger('test-module');
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.debug('debug message', { key: 'value' })).not.toThrow();
    expect(() => logger.warn('warning')).not.toThrow();
    expect(() => logger.error('error')).not.toThrow();
  });

  it('creates loggers for different module names without error', () => {
    const modules = ['core', 'installer', 'policy-engine', 'routing', 'adapters'];
    for (const mod of modules) {
      expect(() => createLogger(mod)).not.toThrow();
    }
  });
});

describe('createRequestLogger', () => {
  it('returns a logger with the standard log methods', () => {
    const logger = createRequestLogger('admin-api', 'req-uuid-123');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('accepts an optional correlationId without throwing', () => {
    expect(() =>
      createRequestLogger('admin-api', 'req-uuid-123', 'corr-uuid-456'),
    ).not.toThrow();
  });

  it('calling log methods on request logger does not throw', () => {
    const logger = createRequestLogger('api', 'req-1');
    expect(() => logger.info('handling request')).not.toThrow();
    expect(() => logger.warn('slow request', { ms: 5000 })).not.toThrow();
  });
});

describe('rootLogger', () => {
  it('is defined and has log methods', () => {
    expect(rootLogger).toBeDefined();
    expect(typeof rootLogger.info).toBe('function');
    expect(typeof rootLogger.error).toBe('function');
  });
});

describe('redactSensitive', () => {
  it('returns non-object values unchanged', () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(true)).toBe(true);
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it('redacts a top-level sensitive key', () => {
    const input = { password: 'mysecret', name: 'Alice' };
    const output = redactSensitive(input) as Record<string, unknown>;
    expect(output['password']).toBe('[REDACTED]');
    expect(output['name']).toBe('Alice');
  });

  it('redacts all known sensitive keys', () => {
    const sensitiveKeys = [
      'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
      'authorization', 'auth', 'key', 'private_key', 'privatekey',
      'credential', 'credentials', 'jwt', 'bearer', 'access_token',
      'refresh_token', 'client_secret', 'encryption_key',
    ];
    for (const k of sensitiveKeys) {
      const input = { [k]: 'supersecret' };
      const output = redactSensitive(input) as Record<string, unknown>;
      expect(output[k]).toBe('[REDACTED]');
    }
  });

  it('is case-insensitive for key matching', () => {
    const input = { PASSWORD: 'p1', Token: 'tok123', SECRET: 'shhh' };
    const output = redactSensitive(input) as Record<string, unknown>;
    expect(output['PASSWORD']).toBe('[REDACTED]');
    expect(output['Token']).toBe('[REDACTED]');
    expect(output['SECRET']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive keys unchanged', () => {
    const input = { username: 'alice', email: 'alice@example.com', age: 30 };
    const output = redactSensitive(input) as Record<string, unknown>;
    expect(output['username']).toBe('alice');
    expect(output['email']).toBe('alice@example.com');
    expect(output['age']).toBe(30);
  });

  it('redacts nested sensitive keys recursively', () => {
    const input = {
      user: { name: 'Bob', password: 'secret123' },
      config: { apikey: 'keyvalue' },
    };
    const output = redactSensitive(input) as Record<string, Record<string, unknown>>;
    expect(output['user']?.['password']).toBe('[REDACTED]');
    expect(output['config']?.['apikey']).toBe('[REDACTED]');
    expect(output['user']?.['name']).toBe('Bob');
  });

  it('handles arrays by redacting sensitive keys within each element', () => {
    const input = [
      { name: 'A', secret: 'x' },
      { name: 'B', token: 'y' },
    ];
    const output = redactSensitive(input) as Array<Record<string, unknown>>;
    expect(Array.isArray(output)).toBe(true);
    expect(output[0]?.['secret']).toBe('[REDACTED]');
    expect(output[1]?.['token']).toBe('[REDACTED]');
    expect(output[0]?.['name']).toBe('A');
    expect(output[1]?.['name']).toBe('B');
  });

  it('handles arrays of primitives without error', () => {
    const input = [1, 'two', null, true];
    const output = redactSensitive(input) as unknown[];
    expect(output).toEqual([1, 'two', null, true]);
  });

  it('stops recursing beyond depth 10 to prevent stack overflow', () => {
    // Build a 12-level deep object
    let deep: Record<string, unknown> = { secret: 'deep-secret' };
    for (let i = 0; i < 12; i++) {
      deep = { nested: deep, secret: `level-${i}-secret` };
    }
    // Should not throw
    expect(() => redactSensitive(deep)).not.toThrow();
  });

  it('returns an empty object for an empty input object', () => {
    const output = redactSensitive({});
    expect(output).toEqual({});
  });

  it('handles an object with only sensitive keys', () => {
    const input = { password: 'p', token: 't', secret: 's' };
    const output = redactSensitive(input) as Record<string, unknown>;
    expect(output['password']).toBe('[REDACTED]');
    expect(output['token']).toBe('[REDACTED]');
    expect(output['secret']).toBe('[REDACTED]');
    expect(Object.values(output).every((v) => v === '[REDACTED]')).toBe(true);
  });

  it('redacts keys inside nested arrays of objects', () => {
    const input = {
      items: [
        { id: 1, apikey: 'k1' },
        { id: 2, apikey: 'k2' },
      ],
    };
    const output = redactSensitive(input) as { items: Array<Record<string, unknown>> };
    expect(output.items[0]?.['apikey']).toBe('[REDACTED]');
    expect(output.items[1]?.['apikey']).toBe('[REDACTED]');
    expect(output.items[0]?.['id']).toBe(1);
  });

  it('handles mixed-type values (non-sensitive key with object value)', () => {
    const input = {
      data: { message: 'hello', nested: { value: 42 } },
    };
    const output = redactSensitive(input) as { data: { message: string; nested: { value: number } } };
    expect(output.data.message).toBe('hello');
    expect(output.data.nested.value).toBe(42);
  });
});
