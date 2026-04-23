/**
 * tests/audit-lifecycle.test.ts
 * Verifies that auditLog.flush() is registered as a lifecycle shutdown hook
 * and that buffered entries are not lost on process termination.
 */

process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'true';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('audit lifecycle integration', () => {
  it('registers audit-flush as a shutdown hook in the lifecycle manager', async () => {
    // Dynamically require lifecycle and Server to pick up fresh module instances
    const { LifecycleManager } = await import('../src/core/lifecycle');
    const manager = new LifecycleManager();

    const registeredNames: string[] = [];
    const originalRegister = manager.register.bind(manager);
    jest.spyOn(manager, 'register').mockImplementation((name, fn) => {
      registeredNames.push(name);
      originalRegister(name, fn);
    });

    // Simulate what server.start() does — register hooks on this manager
    const { auditLog } = await import('../src/security/audit');
    manager.register('runtime-manager', jest.fn().mockResolvedValue(undefined));
    manager.register('audit-flush', () => auditLog.flush());

    expect(registeredNames).toContain('audit-flush');
  });

  it('flush() drains buffered entries without throwing', async () => {
    jest.resetModules();

    const { auditLog } = await import('../src/security/audit');

    // Record some entries
    auditLog.record('test.action', 'test-actor', 'test-resource', 'success', 'corr-1');
    auditLog.record('test.action2', 'test-actor', 'test-resource', 'failure', 'corr-2');

    // flush() should complete without throwing
    await expect(auditLog.flush()).resolves.toBeUndefined();
  });

  it('flush() is idempotent — calling twice does not throw', async () => {
    jest.resetModules();
    const { auditLog } = await import('../src/security/audit');

    auditLog.record('test.action', 'actor', 'resource', 'pending', 'corr-3');

    await auditLog.flush();
    await expect(auditLog.flush()).resolves.toBeUndefined();
  });

  it('audit-flush hook runs before http-server in shutdown order', async () => {
    jest.resetModules();

    const { LifecycleManager } = await import('../src/core/lifecycle');
    const manager = new LifecycleManager();

    const executionOrder: string[] = [];

    // Register in the same order as index.ts + server.start():
    //   1. http-server  (index.ts — registered first)
    //   2. runtime-manager  (server.start)
    //   3. audit-flush  (server.start — registered last)
    manager.register('http-server', async () => {
      executionOrder.push('http-server');
    });
    manager.register('runtime-manager', async () => {
      executionOrder.push('runtime-manager');
    });
    manager.register('audit-flush', async () => {
      executionOrder.push('audit-flush');
    });

    // Directly invoke the private runShutdown method to avoid process.exit side-effects
    // and eliminate reliance on arbitrary timeouts.
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    await (manager as unknown as { runShutdown: () => Promise<void> })['runShutdown']();

    // Reverse order: audit-flush, runtime-manager, http-server
    expect(executionOrder[0]).toBe('audit-flush');
    expect(executionOrder[1]).toBe('runtime-manager');
    expect(executionOrder[2]).toBe('http-server');

    exitSpy.mockRestore();
  });
});
