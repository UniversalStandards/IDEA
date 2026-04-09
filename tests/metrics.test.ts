/**
 * Tests for the metrics registry.
 */
import { MetricsRegistry } from '../src/observability/metrics';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe('increment (counter)', () => {
    it('increments a counter', () => {
      registry.increment('requests_total');
      registry.increment('requests_total');
      const snap = registry.getSnapshot();
      const entry = snap.counters.find((m) => m.name === 'requests_total');
      expect(entry).toBeDefined();
      expect(entry!.value).toEqual(2);
    });

    it('supports labels', () => {
      registry.increment('requests_total', { method: 'GET' });
      registry.increment('requests_total', { method: 'POST' });
      registry.increment('requests_total', { method: 'GET' });
      const snap = registry.getSnapshot();
      const get = snap.counters.find((m) => m.name === 'requests_total' && m.labels?.['method'] === 'GET');
      const post = snap.counters.find((m) => m.name === 'requests_total' && m.labels?.['method'] === 'POST');
      expect(get?.value).toEqual(2);
      expect(post?.value).toEqual(1);
    });

    it('supports custom increment amount', () => {
      registry.increment('bytes_received', {}, 1024);
      const snap = registry.getSnapshot();
      const entry = snap.counters.find((m) => m.name === 'bytes_received');
      expect(entry?.value).toEqual(1024);
    });
  });

  describe('gauge', () => {
    it('sets and updates a gauge', () => {
      registry.gauge('active_connections', 5);
      registry.gauge('active_connections', 12);
      const snap = registry.getSnapshot();
      const entry = snap.gauges.find((m) => m.name === 'active_connections');
      expect(entry?.value).toEqual(12);
    });
  });

  describe('histogram', () => {
    it('records histogram observations', () => {
      registry.histogram('request_latency_ms', 50);
      registry.histogram('request_latency_ms', 200);
      registry.histogram('request_latency_ms', 350);
      const snap = registry.getSnapshot();
      const entry = snap.histograms.find((m) => m.name === 'request_latency_ms');
      expect(entry).toBeDefined();
      expect(entry!.count).toEqual(3);
      expect(entry!.sum).toEqual(600);
    });
  });

  describe('getSnapshot', () => {
    it('returns an object with counters, gauges, histograms arrays and a timestamp', () => {
      registry.increment('foo');
      const snap = registry.getSnapshot();
      expect(Array.isArray(snap.counters)).toBe(true);
      expect(Array.isArray(snap.gauges)).toBe(true);
      expect(Array.isArray(snap.histograms)).toBe(true);
      expect(snap).toHaveProperty('timestamp');
    });

    it('is non-destructive (can be called multiple times)', () => {
      registry.increment('bar');
      registry.getSnapshot();
      const snap2 = registry.getSnapshot();
      const entry = snap2.counters.find((m) => m.name === 'bar');
      expect(entry?.value).toEqual(1);
    });
  });
});
