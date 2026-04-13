export type LabelMap = Record<string, string | number | boolean>;

interface CounterEntry {
  type: 'counter';
  name: string;
  labels: LabelMap;
  value: number;
}

interface GaugeEntry {
  type: 'gauge';
  name: string;
  labels: LabelMap;
  value: number;
}

interface HistogramEntry {
  type: 'histogram';
  name: string;
  labels: LabelMap;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Map<number, number>;
}

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

export interface MetricsSnapshot {
  counters: Array<{ name: string; labels: LabelMap; value: number }>;
  gauges: Array<{ name: string; labels: LabelMap; value: number }>;
  histograms: Array<{
    name: string;
    labels: LabelMap;
    count: number;
    sum: number;
    min: number;
    max: number;
    mean: number;
    buckets: Record<string, number>;
  }>;
  timestamp: string;
}

const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function serializeKey(name: string, labels: LabelMap): string {
  const sorted = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return sorted ? `${name}{${sorted}}` : name;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricEntry>();

  increment(name: string, labels: LabelMap = {}, amount = 1): void {
    const key = serializeKey(name, labels);
    const existing = this.metrics.get(key);
    if (existing?.type === 'counter') {
      existing.value += amount;
    } else {
      this.metrics.set(key, { type: 'counter', name, labels, value: amount });
    }
  }

  gauge(name: string, value: number, labels: LabelMap = {}): void {
    const key = serializeKey(name, labels);
    this.metrics.set(key, { type: 'gauge', name, labels, value });
  }

  histogram(name: string, value: number, labels: LabelMap = {}): void {
    const key = serializeKey(name, labels);
    const existing = this.metrics.get(key);
    if (existing?.type === 'histogram') {
      existing.count += 1;
      existing.sum += value;
      if (value < existing.min) existing.min = value;
      if (value > existing.max) existing.max = value;
      for (const bucket of DEFAULT_HISTOGRAM_BUCKETS) {
        if (value <= bucket) {
          existing.buckets.set(bucket, (existing.buckets.get(bucket) ?? 0) + 1);
        }
      }
    } else {
      const buckets = new Map<number, number>();
      for (const bucket of DEFAULT_HISTOGRAM_BUCKETS) {
        if (value <= bucket) buckets.set(bucket, 1);
      }
      this.metrics.set(key, {
        type: 'histogram',
        name,
        labels,
        count: 1,
        sum: value,
        min: value,
        max: value,
        buckets,
      });
    }
  }

  getSnapshot(): MetricsSnapshot {
    const counters: MetricsSnapshot['counters'] = [];
    const gauges: MetricsSnapshot['gauges'] = [];
    const histograms: MetricsSnapshot['histograms'] = [];

    for (const entry of this.metrics.values()) {
      if (entry.type === 'counter') {
        counters.push({ name: entry.name, labels: entry.labels, value: entry.value });
      } else if (entry.type === 'gauge') {
        gauges.push({ name: entry.name, labels: entry.labels, value: entry.value });
      } else {
        const bucketsObj: Record<string, number> = {};
        for (const [bound, cnt] of entry.buckets) {
          bucketsObj[String(bound)] = cnt;
        }
        histograms.push({
          name: entry.name,
          labels: entry.labels,
          count: entry.count,
          sum: entry.sum,
          min: entry.min,
          max: entry.max,
          mean: entry.count > 0 ? entry.sum / entry.count : 0,
          buckets: bucketsObj,
        });
      }
    }

    return { counters, gauges, histograms, timestamp: new Date().toISOString() };
  }

  reset(): void {
    this.metrics.clear();
  }
}

export const metrics = new MetricsRegistry();
