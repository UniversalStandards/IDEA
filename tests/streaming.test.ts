import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { MetricsRegistry } from '../src/observability/metrics';
import { BackpressureManager } from '../src/streaming/BackpressureManager';
import { ChunkedHttpHandler } from '../src/streaming/ChunkedHttpHandler';
import { SseHandler } from '../src/streaming/SseHandler';
import { StreamManager } from '../src/streaming/StreamManager';
import { StreamMultiplexer } from '../src/streaming/StreamMultiplexer';
import { WsLikeConnection, WsStreamHandler } from '../src/streaming/WsStreamHandler';
import { StreamEventType } from '../src/types/streaming.types';

class MockRequest extends EventEmitter {
  query: Record<string, string> = {};
  headers: Record<string, string> = {};
}

class MockResponse extends EventEmitter {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public writes: string[] = [];

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {
    // no-op for tests
  }

  write(chunk: string | Buffer): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    return true;
  }

  end(): void {
    this.emit('close');
  }

  json(payload: unknown): void {
    this.writes.push(JSON.stringify(payload));
  }
}

class MockChunkedResponse extends EventEmitter {
  public writes: Buffer[] = [];
  public statusCode = 200;
  private writeCount = 0;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(): void {
    // no-op for tests
  }

  write(chunk: string | Buffer): boolean {
    const encoded = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.writes.push(encoded);
    this.writeCount += 1;
    if (this.writeCount === 1) {
      setImmediate(() => this.emit('drain'));
      return false;
    }
    return true;
  }

  end(): void {
    this.emit('close');
  }
}

class MockWsConnection extends EventEmitter implements WsLikeConnection {
  public sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

describe('streaming module', () => {
  it('replays SSE events from Last-Event-ID and streams new events immediately', () => {
    const manager = new StreamManager({ replayBufferSize: 10, cleanupDelayMs: 25 });
    manager.createStream('stream-1', 'org-1');
    manager.publish('stream-1', StreamEventType.TOKEN, { token: 'a' });
    manager.publish('stream-1', StreamEventType.TOKEN, { token: 'b' });

    const handler = new SseHandler({ streamManager: manager, heartbeatMs: 60_000 });
    const route = handler.createRoute();

    const req = new MockRequest();
    req.query = { streamId: 'stream-1', orgId: 'org-1' };
    req.headers = { 'last-event-id': '1' };
    const res = new MockResponse();

    const start = Date.now();
    route(req as unknown as Request, res as unknown as Response, (() => undefined) as never);
    manager.publish('stream-1', StreamEventType.TOKEN, { token: 'c' });
    const firstTokenDelayMs = Date.now() - start;

    const output = res.writes.join('');
    expect(output).toContain('"token":"b"');
    expect(output).toContain('"token":"c"');
    expect(firstTokenDelayMs).toBeLessThan(100);

    req.emit('close');
  });

  it('cleans up disconnected streams within 5 seconds', () => {
    jest.useFakeTimers();
    const manager = new StreamManager({ cleanupDelayMs: 5000 });
    manager.createStream('stream-cleanup', 'org-1');

    manager.markDisconnected('stream-cleanup');
    jest.advanceTimersByTime(5000);

    expect(manager.getActiveStreamCount()).toBe(0);
    jest.useRealTimers();
  });

  it('emits active stream and bytes-per-second metrics', () => {
    const registry = new MetricsRegistry();
    const manager = new StreamManager({ metricsRegistry: registry });
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(0);
    manager.createStream('stream-metrics', 'org-1');
    manager.publish('stream-metrics', StreamEventType.TOKEN, { token: 'one' });

    nowSpy.mockReturnValue(1000);
    manager.publish('stream-metrics', StreamEventType.TOKEN, { token: 'two' });

    const snapshot = registry.getSnapshot();
    expect(snapshot.gauges.find((g) => g.name === 'stream_active_count')?.value).toBe(1);
    expect(snapshot.gauges.find((g) => g.name === 'stream_bytes_per_sec')).toBeDefined();

    nowSpy.mockRestore();
  });

  it('chunks and reassembles WebSocket messages', () => {
    const received: unknown[] = [];
    const handler = new WsStreamHandler({
      chunkSizeBytes: 8,
      onMessage: (message) => {
        received.push(message.payload);
      },
    });
    const connection = new MockWsConnection();
    handler.attachConnection(connection);

    handler.send(connection, {
      streamId: 'stream-1',
      orgId: 'org-1',
      payload: { content: 'this message is longer than 8 bytes' },
    });

    expect(connection.sent.length).toBeGreaterThan(1);

    for (const frame of connection.sent) {
      connection.emit('message', frame);
    }

    expect(received).toEqual([{ content: 'this message is longer than 8 bytes' }]);
  });

  it('pauses and resumes producers based on backpressure thresholds', () => {
    const registry = new MetricsRegistry();
    const pause = jest.fn();
    const resume = jest.fn();
    const manager = new BackpressureManager({ metricsRegistry: registry });

    manager.register('stream-pressure', { pause, resume });
    manager.updateBufferUtilization('stream-pressure', 0.81);
    manager.onDrain('stream-pressure');

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);

    const counters = registry.getSnapshot().counters.filter((c) => c.name === 'stream_backpressure_events_total');
    expect(counters.length).toBeGreaterThanOrEqual(2);
  });

  it('demultiplexes logical streams over one physical connection', () => {
    const multiplexer = new StreamMultiplexer();
    const perStreamCount = new Map<string, number>();

    for (let index = 0; index < 10; index += 1) {
      const streamId = `stream-${index}`;
      multiplexer.subscribe(streamId, () => {
        perStreamCount.set(streamId, (perStreamCount.get(streamId) ?? 0) + 1);
      });
    }

    const delivered = multiplexer.demultiplex({
      streamId: 'stream-7',
      orgId: 'org-1',
      eventType: StreamEventType.PROGRESS,
      sequence: 1,
      data: { step: 'running' },
      timestamp: Date.now(),
    });

    expect(delivered).toBe(true);
    expect(perStreamCount.get('stream-7')).toBe(1);
    expect(perStreamCount.get('stream-3')).toBeUndefined();
  });

  it('streams chunked HTTP output and handles drain backpressure', async () => {
    const handler = new ChunkedHttpHandler({ metricsRegistry: new MetricsRegistry() });
    const res = new MockChunkedResponse();
    handler.initialize(res as unknown as Response, 'text/plain');

    await handler.streamChunks(res as unknown as Response, ['part-1', 'part-2']);

    expect(Buffer.concat(res.writes).toString('utf8')).toBe('part-1part-2');
  });
});
