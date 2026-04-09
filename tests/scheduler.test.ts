/**
 * Tests for the priority scheduler.
 */
import { Scheduler } from '../src/routing/scheduler';

describe('Scheduler', () => {
  it('executes a single task and returns its result', async () => {
    const scheduler = new Scheduler(2);
    const result = await scheduler.schedule(() => Promise.resolve(42));
    expect(result).toEqual(42);
  });

  it('runs tasks concurrently up to maxConcurrency', async () => {
    const concurrency = 3;
    const scheduler = new Scheduler(concurrency);
    let running = 0;
    let peakRunning = 0;

    const tasks = Array.from({ length: 6 }, () =>
      scheduler.schedule(async () => {
        running++;
        peakRunning = Math.max(peakRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return running;
      }),
    );

    await Promise.all(tasks);
    expect(peakRunning).toBeLessThanOrEqual(concurrency);
  });

  it('executes tasks in priority order (higher first)', async () => {
    const scheduler = new Scheduler(1); // serial to observe order
    const order: number[] = [];

    // Use a gate to hold the first task so all three are truly queued
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });

    // Fill the one concurrency slot with a gated task so p0/p1/p2 all queue up
    const gated = scheduler.schedule(async () => { await gate; });

    // Now enqueue all three — they all end up in the priority queue
    const p0 = scheduler.schedule(async () => { order.push(0); }, 0);
    const p1 = scheduler.schedule(async () => { order.push(1); }, 10);
    const p2 = scheduler.schedule(async () => { order.push(2); }, 5);

    // Release the gate so the queued tasks can run
    releaseGate();
    await Promise.all([gated, p0, p1, p2]);

    // Priority 10 should run before priority 5, priority 5 before priority 0
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(0));
  });

  it('propagates task errors to the promise', async () => {
    const scheduler = new Scheduler(2);
    await expect(
      scheduler.schedule(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('getStats returns sensible values after execution', async () => {
    const scheduler = new Scheduler(2);
    await scheduler.schedule(() => Promise.resolve('ok'));
    const stats = scheduler.getStats();
    expect(stats.completed).toBeGreaterThanOrEqual(1);
    expect(stats.queued).toBeGreaterThanOrEqual(0);
  });
});
