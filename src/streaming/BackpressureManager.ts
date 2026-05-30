import { metrics } from '../observability/metrics';
import type { MetricsRegistry } from '../observability/metrics';

export interface StreamProducer {
  pause: () => void;
  resume: () => void;
}

interface ManagedProducer {
  producer: StreamProducer;
  paused: boolean;
}

export interface BackpressureManagerOptions {
  readonly pauseThreshold?: number;
  readonly resumeThreshold?: number;
  readonly metricsRegistry?: MetricsRegistry;
}

export class BackpressureManager {
  private readonly pauseThreshold: number;
  private readonly resumeThreshold: number;
  private readonly metricsRegistry: MetricsRegistry;
  private readonly producers = new Map<string, ManagedProducer>();

  constructor(options: BackpressureManagerOptions = {}) {
    this.pauseThreshold = options.pauseThreshold ?? 0.8;
    this.resumeThreshold = options.resumeThreshold ?? 0.6;
    this.metricsRegistry = options.metricsRegistry ?? metrics;
  }

  register(streamId: string, producer: StreamProducer): void {
    this.producers.set(streamId, { producer, paused: false });
  }

  unregister(streamId: string): void {
    this.producers.delete(streamId);
  }

  updateBufferUtilization(streamId: string, utilization: number): void {
    const managed = this.producers.get(streamId);
    if (!managed) {
      return;
    }

    if (!managed.paused && utilization >= this.pauseThreshold) {
      managed.producer.pause();
      managed.paused = true;
      this.metricsRegistry.increment('stream_backpressure_events_total', { action: 'pause' });
      return;
    }

    if (managed.paused && utilization <= this.resumeThreshold) {
      managed.producer.resume();
      managed.paused = false;
      this.metricsRegistry.increment('stream_backpressure_events_total', { action: 'resume' });
    }
  }

  onDrain(streamId: string): void {
    this.updateBufferUtilization(streamId, 0);
  }

  isPaused(streamId: string): boolean {
    return this.producers.get(streamId)?.paused ?? false;
  }
}
