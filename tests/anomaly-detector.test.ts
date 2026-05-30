import { AnomalyDetector } from '../src/observability/AnomalyDetector';

describe('AnomalyDetector', () => {
  it('emits anomaly.detected for 3-sigma deviations', () => {
    const detector = new AnomalyDetector({ minSamples: 5, sigmaThreshold: 3 });
    const events: unknown[] = [];
    detector.on('anomaly.detected', (payload) => events.push(payload));

    for (let i = 0; i < 10; i++) {
      detector.observe({
        orgId: 'org-1',
        metricKey: 'latency_ms',
        value: 100 + (i % 2),
        timestamp: new Date(`2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`),
      });
    }

    const anomaly = detector.observe({
      orgId: 'org-1',
      metricKey: 'latency_ms',
      value: 1000,
      timestamp: new Date('2026-01-01T00:01:00.000Z'),
    });

    expect(anomaly).toBeDefined();
    expect(events).toHaveLength(1);
    expect(anomaly?.zScore).toBeGreaterThan(3);
  });
});
