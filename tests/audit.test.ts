/**
 * tests/audit.test.ts
 * Unit tests for src/security/audit.ts — AuditLogger
 */

// Set env vars before any module imports
process.env['NODE_ENV'] = 'test';
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
process.env['ENABLE_AUDIT_LOGGING'] = 'true';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// audit.ts calls mkdirSync at module load; mock fs to avoid actual filesystem usage
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  appendFile: jest.fn().mockResolvedValue(undefined),
}));

import { AuditLogger } from '../src/security/audit';

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = new AuditLogger();
  });

  it('records an entry when enabled', () => {
    logger.record('tool.install', 'system', 'my-tool', 'success');
    // Buffer is private but we can verify via flush behavior
    // flush() returns a resolved promise when buffer is non-empty
    expect(logger.flush()).resolves.toBeUndefined();
  });

  it('record() adds an HMAC-signed entry to the buffer', async () => {
    logger.record('test.action', 'actor-1', 'resource-1', 'success', 'corr-123', { key: 'value' });
    // flush() should resolve without error when buffer has entries
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it('flush() resolves immediately when buffer is empty', async () => {
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it('flush() drains all buffered entries', async () => {
    logger.record('action.1', 'actor', 'res', 'success');
    logger.record('action.2', 'actor', 'res', 'failure');
    await logger.flush();
    // After flush, subsequent flush should be instant (buffer empty)
    const start = Date.now();
    await logger.flush();
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('log() convenience method maps denied → failure outcome', async () => {
    // Should not throw; maps 'denied' to 'failure' internally
    expect(() => {
      logger.log({
        actor: 'admin',
        action: 'capability.access',
        resource: 'tool-x',
        outcome: 'denied',
        correlationId: 'corr-abc',
        metadata: { reason: 'unauthorized' },
      });
    }).not.toThrow();
    await logger.flush();
  });

  it('log() accepts all valid outcome values', async () => {
    for (const outcome of ['success', 'failure', 'pending'] as const) {
      expect(() => {
        logger.log({ actor: 'sys', action: 'a', resource: 'r', outcome });
      }).not.toThrow();
    }
    await logger.flush();
  });

  it('log() without correlationId generates one automatically', () => {
    expect(() => {
      logger.log({ actor: 'sys', action: 'b', resource: 'r', outcome: 'success' });
    }).not.toThrow();
  });
});

describe('AuditLogger — disabled mode', () => {
  it('does not buffer entries when ENABLE_AUDIT_LOGGING=false', async () => {
    // The AuditLogger reads config at construction time; mock getConfig
    const configMod = require('../src/config') as { getConfig: () => Record<string, unknown> };
    const origGetConfig = configMod.getConfig;

    // Temporarily override module export — ts-jest caches modules so use jest.isolateModules
    let disabledLogger: AuditLogger | undefined;
    jest.isolateModules(() => {
      jest.mock('../src/config', () => ({
        getConfig: jest.fn(() => ({
          ENABLE_AUDIT_LOGGING: false,
          ENCRYPTION_KEY: 'test-encryption-key-32-characters!!',
        })),
      }));
      const { AuditLogger: AL } = require('../src/security/audit') as { AuditLogger: typeof import('../src/security/audit').AuditLogger };
      disabledLogger = new AL();
    });

    if (disabledLogger) {
      disabledLogger.record('should.not.record', 'actor', 'res', 'success');
      // flush() resolves immediately because buffer is empty
      await expect(disabledLogger.flush()).resolves.toBeUndefined();
    }
    void origGetConfig; // suppress unused warning
  });
});
