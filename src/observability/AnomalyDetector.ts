import { EventEmitter } from 'events';

export interface MetricObservation {
  orgId: string;
  metricKey: string;
  value: number;
  timestamp?: Date;
}

export interface AnomalyRecord {
  orgId: string;
  metricKey: string;
  value: number;
  mean: number;
  stdDev: number;
  zScore: number;
  detectedAt: string;
}

interface DetectorOptions {
  baselineWindowMs?: number;
  sigmaThreshold?: number;
  minSamples?: number;
}

interface Point {
  ts: number;
  value: number;
}

export class AnomalyDetector extends EventEmitter {
  private readonly baselineWindowMs: number;
  private readonly sigmaThreshold: number;
  private readonly minSamples: number;
  private readonly points = new Map<string, Point[]>();

  constructor(options: DetectorOptions = {}) {
    super();
    this.baselineWindowMs = options.baselineWindowMs ?? 7 * 24 * 60 * 60 * 1000;
    this.sigmaThreshold = options.sigmaThreshold ?? 3;
    this.minSamples = options.minSamples ?? 30;
  }

  observe(observation: MetricObservation): AnomalyRecord | undefined {
    const now = observation.timestamp ?? new Date();
    const key = `${observation.orgId}:${observation.metricKey}`;
    const series = this.points.get(key) ?? [];
    const nowMs = now.getTime();
    const cutoff = nowMs - this.baselineWindowMs;
    const baseline = series.filter((point) => point.ts >= cutoff);

    const anomaly = this.detect(observation, baseline, now);
    baseline.push({ ts: nowMs, value: observation.value });
    this.points.set(key, baseline);

    if (anomaly) {
      this.emit('anomaly.detected', anomaly);
    }

    return anomaly;
  }

  private detect(observation: MetricObservation, baseline: Point[], now: Date): AnomalyRecord | undefined {
    if (baseline.length < this.minSamples) {
      return undefined;
    }
    const mean = baseline.reduce((acc, point) => acc + point.value, 0) / baseline.length;
    const variance = baseline.reduce((acc, point) => acc + (point.value - mean) ** 2, 0) / baseline.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) {
      return undefined;
    }
    const zScore = (observation.value - mean) / stdDev;
    if (Math.abs(zScore) < this.sigmaThreshold) {
      return undefined;
    }
    return {
      orgId: observation.orgId,
      metricKey: observation.metricKey,
      value: observation.value,
      mean,
      stdDev,
      zScore,
      detectedAt: now.toISOString(),
    };
  }
}
