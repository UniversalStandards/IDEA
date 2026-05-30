import type { StreamEvent } from '../types/streaming.types';

export interface MultiplexedMessage<TPayload = unknown> {
  readonly streamId: string;
  readonly orgId: string;
  readonly payload: TPayload;
}

export class StreamMultiplexer {
  private readonly listeners = new Map<string, Set<(event: StreamEvent) => void>>();

  subscribe(streamId: string, listener: (event: StreamEvent) => void): () => void {
    const streamListeners = this.listeners.get(streamId) ?? new Set<(event: StreamEvent) => void>();
    streamListeners.add(listener);
    this.listeners.set(streamId, streamListeners);

    return () => {
      const existing = this.listeners.get(streamId);
      if (!existing) {
        return;
      }
      existing.delete(listener);
      if (existing.size === 0) {
        this.listeners.delete(streamId);
      }
    };
  }

  demultiplex(event: StreamEvent): boolean {
    const streamListeners = this.listeners.get(event.streamId);
    if (!streamListeners || streamListeners.size === 0) {
      return false;
    }

    for (const listener of streamListeners) {
      listener(event);
    }

    return true;
  }

  multiplex<TPayload>(streamId: string, orgId: string, payload: TPayload): MultiplexedMessage<TPayload> {
    return { streamId, orgId, payload };
  }

  getSubscriptionCount(streamId: string): number {
    return this.listeners.get(streamId)?.size ?? 0;
  }
}
