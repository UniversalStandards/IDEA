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

// Stable warn mock — same reference across all createLogger() calls; cleared in beforeEach
const mockWarn = jest.fn();

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: mockWarn,
    error: jest.fn(),
  }),
}));

import { CostMonitor } from '../src/observability/cost-monitor';

describe('CostMonitor', () => {
  let monitor: CostMonitor;

  beforeEach(() => {
    mockWarn.mockClear();
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
    // Push an event, then query with 0ms window (nothing in range)
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    const summary = monitor.getCostSummary(0);
    expect(summary.requestCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
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
    const { getConfig } = require('../src/config') as { getConfig: jest.Mock };
    getConfig.mockReturnValueOnce({ COST_TRACKING_ENABLED: false, COST_BUDGET_DAILY_USD: 0 });
    monitor.record({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUsd: 0.01, requestId: 'r1' });
    expect(monitor.getEventCount()).toBe(0);
  });

  it('daily budget limit emits a warning when exceeded', () => {
    const { getConfig } = require('../src/config') as { getConfig: jest.Mock };

    // Set budget to $0.005 so the first $0.01 event exceeds it
    getConfig.mockReturnValue({
      COST_TRACKING_ENABLED: true,
      COST_BUDGET_DAILY_USD: 0.005,
      ENABLE_AUDIT_LOGGING: false,
    });

    // Create a fresh monitor so it picks up the new config mock
    const budgetMonitor = new CostMonitor();
    budgetMonitor.record({
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      requestId: 'budget-r1',
    });

    // Restore default mock to avoid polluting other tests
    getConfig.mockReturnValue({
      COST_TRACKING_ENABLED: true,
      COST_BUDGET_DAILY_USD: 0,
      ENABLE_AUDIT_LOGGING: false,
    });

    // The logger.warn mock is captured per createLogger() call
    expect(mockWarn).toHaveBeenCalledWith(
      'Daily cost budget exceeded',
      expect.objectContaining({ budget: 0.005, actual: 0.01 }),
    );
  });
});
