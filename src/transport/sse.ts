import type { Application, Request, Response } from 'express';
import type { Config } from '../config';
import { createLogger } from '../observability/logger';
import type { ITransport } from './index';
import type { ConnectionPool } from './pool';
import { isTransportAuthorized } from './middleware/auth';

const logger = createLogger('sse-transport');
const DEFAULT_HEARTBEAT_MS = 15_000;

interface SseClient {
  readonly clientId: string;
  readonly response: Response;
}

export interface SseTransportOptions {
  readonly app: Application;
  readonly config: Pick<Config, 'JWT_SECRET'>;
  readonly connectionPool: ConnectionPool;
  readonly path?: string;
  readonly heartbeatMs?: number;
}

export class SseTransport implements ITransport {
  readonly name = 'sse' as const;
  private readonly clients = new Map<string, SseClient>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly options: SseTransportOptions) {}

  async initialize(): Promise<void> {
    const path = this.options.path ?? '/transport/sse';

    this.options.app.get(path, (req: Request, res: Response) => {
      if (
        !isTransportAuthorized({
          authorization: req.headers['authorization'],
          token: typeof req.query['token'] === 'string' ? req.query['token'] : undefined,
          config: this.options.config,
        })
      ) {
        res.status(401).json({ error: 'Unauthorized transport request' });
        return;
      }

      const clientId = resolveClientId(req);
      const lease = this.options.connectionPool.acquire(clientId, { close: () => res.end() });
      if (!lease.allowed) {
        res.status(429).json({ error: 'Connection limit exceeded' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      this.clients.set(lease.connectionId, { clientId, response: res });
      this.publish({ type: 'connected', connectionId: lease.connectionId }, {
        connectionId: lease.connectionId,
        event: 'connected',
      });

      req.on('close', () => {
        this.clients.delete(lease.connectionId);
        this.options.connectionPool.release(clientId, lease.connectionId);
      });
    });

    if (!this.heartbeat) {
      const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      this.heartbeat = setInterval(() => {
        for (const client of this.clients.values()) {
          client.response.write(': keep-alive\n\n');
        }
      }, heartbeatMs);
      this.heartbeat.unref();
    }
  }

  async start(): Promise<void> {
    logger.info('SSE transport ready', { path: this.options.path ?? '/transport/sse' });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    for (const [connectionId, client] of this.clients) {
      client.response.end();
      this.options.connectionPool.release(client.clientId, connectionId);
    }
    this.clients.clear();
  }

  publish(
    payload: unknown,
    options: { connectionId?: string; clientId?: string; event?: string } = {},
  ): void {
    const serialized = JSON.stringify(payload);

    for (const [connectionId, client] of this.clients) {
      if (options.connectionId && options.connectionId !== connectionId) {
        continue;
      }
      if (options.clientId && options.clientId !== client.clientId) {
        continue;
      }

      if (options.event) {
        client.response.write(`event: ${options.event}\n`);
      }
      client.response.write(`data: ${serialized}\n\n`);
    }
  }
}

function resolveClientId(req: Request): string {
  const fromQuery = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : undefined;
  const fromHeader = req.headers['x-client-id'];
  if (fromQuery) {
    return fromQuery;
  }
  if (typeof fromHeader === 'string' && fromHeader.length > 0) {
    return fromHeader;
  }
  return req.ip ?? 'anonymous';
}
