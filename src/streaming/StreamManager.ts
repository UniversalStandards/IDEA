import { metrics } from '../observability/metrics';
import type { MetricsRegistry } from '../observability/metrics';
import type { StreamEvent, StreamEventType, StreamMeta } from '../types/streaming.types';

interface ManagedStream {
  meta: StreamMeta;
  buffer: StreamEvent[];
  listeners: Set<(event: StreamEvent) => void>;
  cleanupTimer: NodeJS.Timeout | undefined;
}

export interface StreamManagerOptions {
  readonly replayBufferSize?: number;
  readonly cleanupDelayMs?: number;
  readonly metricsRegistry?: MetricsRegistry;
}

export class StreamManager {
  private readonly streams = new Map<string, ManagedStream>();
  private readonly replayBufferSize: number;
  private readonly cleanupDelayMs: number;
  private readonly metricsRegistry: MetricsRegistry;
  private windowStart = Date.now();
  private bytesInWindow = 0;

  constructor(options: StreamManagerOptions = {}) {
    this.replayBufferSize = options.replayBufferSize ?? 200;
    this.cleanupDelayMs = options.cleanupDelayMs ?? 5000;
    this.metricsRegistry = options.metricsRegistry ?? metrics;
  }

  createStream(streamId: string, orgId: string): StreamMeta {
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      existing.meta = {
        ...existing.meta,
        orgId,
        connected: true,
        updatedAt: Date.now(),
      };
      return existing.meta;
    }

    const now = Date.now();
    const meta: StreamMeta = {
      streamId,
      orgId,
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
      connected: true,
    };

    this.streams.set(streamId, {
      meta,
      buffer: [],
      listeners: new Set(),
      cleanupTimer: undefined,
    });

    this.emitActiveStreamGauge();
    return meta;
  }

  publish(streamId: string, eventType: StreamEventType, data: unknown): StreamEvent {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Unknown stream: ${streamId}`);
    }

    const event: StreamEvent = {
      streamId: stream.meta.streamId,
      orgId: stream.meta.orgId,
      eventType,
      sequence: stream.meta.lastSequence + 1,
      data,
      timestamp: Date.now(),
    };

    stream.meta = {
      ...stream.meta,
      lastSequence: event.sequence,
      updatedAt: event.timestamp,
    };

    stream.buffer.push(event);
    if (stream.buffer.length > this.replayBufferSize) {
      stream.buffer.splice(0, stream.buffer.length - this.replayBufferSize);
    }

    const encoded = Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.bytesInWindow += encoded;
    this.emitBytesPerSecond(stream.meta.orgId);

    for (const listener of stream.listeners) {
      listener(event);
    }

    return event;
  }

  subscribe(streamId: string, listener: (event: StreamEvent) => void): () => void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Unknown stream: ${streamId}`);
    }

    stream.listeners.add(listener);

    return () => {
      stream.listeners.delete(listener);
    };
  }

  replayFrom(streamId: string, lastEventId?: string): StreamEvent[] {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return [];
    }

    const sequence = this.parseLastEventId(lastEventId);
    if (sequence === undefined) {
      return [...stream.buffer];
    }

    return stream.buffer.filter((event) => event.sequence > sequence);
  }

  markDisconnected(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }

    stream.meta = {
      ...stream.meta,
      connected: false,
      updatedAt: Date.now(),
    };

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
    }

    stream.cleanupTimer = setTimeout(() => {
      this.deleteStream(streamId);
    }, this.cleanupDelayMs);
  }

  closeStream(streamId: string): void {
    this.deleteStream(streamId);
  }

  getActiveStreamCount(): number {
    return this.streams.size;
  }

  getStreamMeta(streamId: string): StreamMeta | undefined {
    return this.streams.get(streamId)?.meta;
  }

  private deleteStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
    }

    stream.listeners.clear();
    this.streams.delete(streamId);
    this.emitActiveStreamGauge();
  }

  private parseLastEventId(lastEventId?: string): number | undefined {
    if (!lastEventId) {
      return undefined;
    }
    const value = Number.parseInt(lastEventId, 10);
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return value;
  }

  private emitActiveStreamGauge(): void {
    this.metricsRegistry.gauge('stream_active_count', this.streams.size);
  }

  private emitBytesPerSecond(orgId: string): void {
    const now = Date.now();
    const elapsed = now - this.windowStart;
    if (elapsed <= 0) {
      this.windowStart = now;
      this.bytesInWindow = 0;
      return;
    }
    if (elapsed < 1000) {
      return;
    }

    const perSecond = elapsed > 0 ? (this.bytesInWindow / elapsed) * 1000 : 0;
    this.metricsRegistry.gauge('stream_bytes_per_sec', perSecond, { orgId });
    this.windowStart = now;
    this.bytesInWindow = 0;
  }
}
