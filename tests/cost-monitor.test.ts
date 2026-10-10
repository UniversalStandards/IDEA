/**
 * tests/cost-monitor.test.ts
 * Unit tests for src/observability/cost-monitor.ts
 */

jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => ({
    COST_TRACKING_ENABLED: true,
    COST_BUDGET_DAILY_USD: 0,
    ENABLE_AUDIT_LOGGING: false,
  })),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { getConfig } from '../src/config';
import { CostMonitor } from '../src/observability/cost-monitor';

describe('CostMonitor', () => {
  let monitor: CostMonitor;

  beforeEach(() => {
    monitor = new CostMonitor();
  });

  it('records a cost event and returns it in summary', () => {
    monitor.record({
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      requestId: 'req-1',
    });
    const summary = monitor.getCostSummary(60_000);
    expect(summary.requestCount).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.01);
  });

  it('aggregates total cost across multiple events', () => {
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 200, outputTokens: 100, costUsd: 0.02, requestId: 'r2' });
    const summary = monitor.getCostSummary(60_000);
    expect(summary.requestCount).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.03);
  });

  it('aggregates cost by provider', () => {
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    monitor.record({ provider: 'anthropic', model: 'claude-3', inputTokens: 200, outputTokens: 100, costUsd: 0.02, requestId: 'r2' });
    const byProvider = monitor.getCostByProvider();
    expect(byProvider['openai']).toBeCloseTo(0.01);
    expect(byProvider['anthropic']).toBeCloseTo(0.02);
  });

  it('aggregates cost by model', () => {
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.02, requestId: 'r2' });
    const byModel = monitor.getCostByModel();
    expect(byModel['gpt-4']).toBeCloseTo(0.03);
  });

  it('returns empty summary when no events fall within window', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });

      // Move the clock 1s past the event, then ask only for the last 500ms.
      jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const summary = monitor.getCostSummary(500);
      expect(summary.requestCount).toBe(0);
      expect(summary.totalCostUsd).toBe(0);

      // The same event is inside a 5s window.
      expect(monitor.getCostSummary(5_000).requestCount).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears all events on clear()', () => {
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    expect(monitor.getEventCount()).toBe(1);
    monitor.clear();
    expect(monitor.getEventCount()).toBe(0);
    expect(monitor.getCostSummary(60_000).requestCount).toBe(0);
  });

  it('bounds memory by dropping oldest events when over capacity', () => {
    const smallMonitor = new CostMonitor(5);
    for (let i = 0; i < 10; i++) {
      smallMonitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 10, outputTokens: 5, costUsd: 0.001, requestId: `r${String(i)}` });
    }
    expect(smallMonitor.getEventCount()).toBeLessThanOrEqual(5);
  });

  it('does not record when COST_TRACKING_ENABLED=false', () => {
    jest.mocked(getConfig).mockReturnValueOnce({
      COST_TRACKING_ENABLED: false,
      COST_BUDGET_DAILY_USD: 0,
    } as ReturnType<typeof getConfig>);
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    expect(monitor.getEventCount()).toBe(0);
  });
});
