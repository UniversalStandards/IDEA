/**
 * tests/lifecycle.test.ts
 * LifecycleManager.shutdown(): in-process graceful shutdown (used when a
 * stdio MCP client disconnects).
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { LifecycleManager } from '../src/core/lifecycle';

describe('LifecycleManager.shutdown()', () => {
  let exit: jest.SpyInstance;

  beforeEach(() => {
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => exit.mockRestore());

  it('runs hooks in reverse order once, then exits 0', async () => {
    const order: string[] = [];
    const lm = new LifecycleManager();
    lm.register('first', () => {
      order.push('first');
      return Promise.resolve();
    });
    lm.register('second', () => {
      order.push('second');
      return Promise.reject(new Error('hook failure is logged, not fatal'));
    });

    expect(lm.isShuttingDown()).toBe(false);
    await lm.shutdown('client disconnected');
    await lm.shutdown('again');

    expect(lm.isShuttingDown()).toBe(true);
    expect(order).toEqual(['second', 'first']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
