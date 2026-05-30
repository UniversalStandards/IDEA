import type { Request, RequestHandler, Response } from 'express';
import type { StreamManager } from './StreamManager';
import type { StreamEvent } from '../types/streaming.types';

export interface SseHandlerOptions {
  readonly streamManager: StreamManager;
  readonly heartbeatMs?: number;
}

export class SseHandler {
  private readonly streamManager: StreamManager;
  private readonly heartbeatMs: number;

  constructor(options: SseHandlerOptions) {
    this.streamManager = options.streamManager;
    this.heartbeatMs = options.heartbeatMs ?? 15000;
  }

  createRoute(): RequestHandler {
    return (req: Request, res: Response): void => {
      const streamId = this.readQueryValue(req, 'streamId');
      const orgId = this.readQueryValue(req, 'orgId');

      if (!streamId || !orgId) {
        res.status(400).json({ error: 'Missing streamId or orgId' });
        return;
      }

      this.streamManager.createStream(streamId, orgId);

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      res.write(': connected\n\n');

      const replayEvents = this.streamManager.replayFrom(streamId, this.getLastEventId(req));
      for (const event of replayEvents) {
        res.write(this.encodeSseEvent(event));
      }

      const unsubscribe = this.streamManager.subscribe(streamId, (event) => {
        res.write(this.encodeSseEvent(event));
      });

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, this.heartbeatMs);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        this.streamManager.markDisconnected(streamId);
      });
    };
  }

  private getLastEventId(req: Request): string | undefined {
    const raw = req.headers['last-event-id'];
    if (typeof raw === 'string') {
      return raw;
    }
    if (Array.isArray(raw)) {
      return raw[0];
    }
    return undefined;
  }

  private readQueryValue(req: Request, key: string): string | undefined {
    const value = req.query[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
      return value[0];
    }
    return undefined;
  }

  private encodeSseEvent(event: StreamEvent): string {
    return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}
