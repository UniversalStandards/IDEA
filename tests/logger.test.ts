/**
 * tests/logger.test.ts
 * Unit tests for src/observability/logger.ts
 */

import type { Logger } from 'winston';

describe('Logger', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('clamps LOG_LEVEL=silly to debug in production', () => {
    process.env = { ...originalEnv, NODE_ENV: 'production', LOG_LEVEL: 'silly' };
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rootLogger } = require('../src/observability/logger') as { rootLogger: Logger };
    expect(rootLogger.level).toBe('debug');
  });

  it('preserves LOG_LEVEL=silly in non-production environments', () => {
    process.env = { ...originalEnv, NODE_ENV: 'development', LOG_LEVEL: 'silly' };
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rootLogger } = require('../src/observability/logger') as { rootLogger: Logger };
    expect(rootLogger.level).toBe('silly');
  });

  it('uses info as default LOG_LEVEL in production when not set', () => {
    process.env = { ...originalEnv, NODE_ENV: 'production', LOG_LEVEL: undefined as unknown as string };
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rootLogger } = require('../src/observability/logger') as { rootLogger: Logger };
    expect(rootLogger.level).toBe('info');
  });
});
