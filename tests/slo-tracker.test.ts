import { SloTracker, type SloStore, type SloWindowRecord } from '../src/observability/SloTracker';

class TestSloStore implements SloStore {
  private readonly rows = new Map<string, SloWindowRecord>();

  async upsert(record: SloWindowRecord): Promise<void> {
    this.rows.set(`${record.orgId}:${record.sloName}`, record);
  }

  async get(orgId: string, sloName: string): Promise<SloWindowRecord | undefined> {
    return this.rows.get(`${orgId}:${sloName}`);
  }
}

describe('SloTracker', () => {
  it('loads YAML definitions and computes error budget for error-rate SLO', async () => {
    const store = new TestSloStore();
    const tracker = new SloTracker(store);
    tracker.defineFromYaml(
      'org-a',
      `slos:
  - name: api-availability
    target: 0.999
    window: 30d
    indicator: error_rate < 0.001`,
    );

    const ok = await tracker.record('org-a', 'api-availability', { errorRate: 0.0005, totalEvents: 100 });
    const bad = await tracker.record('org-a', 'api-availability', { errorRate: 0.01, totalEvents: 100 });
    const stored = await tracker.getStatus('org-a', 'api-availability');

    expect(ok.successRate).toBe(1);
    expect(bad.successRate).toBeCloseTo(0.5);
    expect(stored?.table).toBe('slo_windows');
    expect(stored?.errorBudgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it('tracks SLOs independently per org', async () => {
    const tracker = new SloTracker(new TestSloStore());
    const yaml = `slos:
  - name: routing-latency
    target: 0.95
    window: 7d
    indicator: p99_latency_ms < 500`;

    tracker.defineFromYaml('org-a', yaml);
    tracker.defineFromYaml('org-b', yaml);

    await tracker.record('org-a', 'routing-latency', { p99LatencyMs: 200, totalEvents: 10 });
    await tracker.record('org-b', 'routing-latency', { p99LatencyMs: 900, totalEvents: 10 });

    const a = await tracker.getStatus('org-a', 'routing-latency');
    const b = await tracker.getStatus('org-b', 'routing-latency');
    expect(a?.successRate).toBe(1);
    expect(b?.successRate).toBe(0);
  });
});
