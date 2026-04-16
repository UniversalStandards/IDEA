jest.mock('fs/promises', () => ({
  appendFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => ({
    ENABLE_AUDIT_LOGGING: true,
    ENCRYPTION_KEY: 'test-key',
  })),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { appendFile, mkdir } from 'fs/promises';
import { auditLog, auditLogger } from '../src/security/audit';

describe('audit logger compatibility', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeAll(() => {
    process.env['NODE_ENV'] = 'development';
  });

  afterAll(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports auditLogger alias and supports legacy log() shape', async () => {
    expect(auditLogger).toBe(auditLog);

    auditLogger.log({
      actor: 'user',
      action: 'policy.check',
      resource: 'tool-x',
      outcome: 'denied',
      metadata: { reason: 'blocked' },
    });

    await auditLog.flush();

    expect(mkdir).toHaveBeenCalledWith(expect.stringMatching(/runtime$/), { recursive: true });
    expect(appendFile).toHaveBeenCalled();
    const payload = String((appendFile as jest.Mock).mock.calls[0]?.[1] ?? '');
    expect(payload).toContain('"outcome":"failure"');
  });
});
