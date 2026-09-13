import type { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Config } from '../config';
import { createLogger } from '../observability/logger';
import type { ITransport } from './index';
import type { ConnectionPool } from './pool';
import { ConnectionRateLimiter } from './middleware/rateLimit';
import { isTransportAuthorized } from './middleware/auth';

const logger = createLogger('ws-transport');

export interface WsTransportOptions {
  readonly server: HttpServer;
  readonly config: Pick<Config, 'JWT_SECRET' | 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX_REQUESTS'>;
  readonly connectionPool: ConnectionPool;
  readonly onMessage: (payload: unknown) => Promise<unknown>;
  readonly path?: string;
  readonly rateLimiter?: ConnectionRateLimiter;
}

export class WsTransport implements ITransport {
  readonly name = 'websocket' as const;
  private server: WebSocketServer | undefined;
  private readonly connections = new Map<string, { clientId: string; socket: WebSocket }>();
  private readonly rateLimiter: ConnectionRateLimiter;

  constructor(private readonly options: WsTransportOptions) {
    this.rateLimiter =
      options.rateLimiter ??
      new ConnectionRateLimiter({
        windowMs: options.config.RATE_LIMIT_WINDOW_MS,
        maxRequests: options.config.RATE_LIMIT_MAX_REQUESTS,
      });
  }

  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      server: this.options.server,
      path: this.options.path ?? '/transport/ws',
    });

    this.server.on('connection', (socket, request) => {
      void this.handleConnection(socket, request);
    });
    logger.info('WebSocket transport ready', { path: this.options.path ?? '/transport/ws' });
  }

  async stop(): Promise<void> {
    const currentServer = this.server;
    this.server = undefined;

    for (const [connectionId, connection] of this.connections) {
      connection.socket.close();
      this.options.connectionPool.release(connection.clientId, connectionId);
    }
    this.connections.clear();

    if (!currentServer) {
      return;
    }

    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve());
    });
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const clientId = resolveClientId(request);
    if (
      !isTransportAuthorized({
        authorization: request.headers['authorization'],
        token: resolveQueryToken(request.url),
        config: this.options.config,
      })
    ) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    const lease = this.options.connectionPool.acquire(clientId, { close: () => socket.close() });
    if (!lease.allowed) {
      socket.close(1013, 'Connection limit exceeded');
      return;
    }

    this.connections.set(lease.connectionId, { clientId, socket });
    socket.send(JSON.stringify({ type: 'connected' }));

    socket.on('message', (message) => {
      void this.handleMessage(lease.connectionId, clientId, socket, message);
    });
    socket.once('close', () => {
      this.connections.delete(lease.connectionId);
      this.options.connectionPool.release(clientId, lease.connectionId);
    });
    socket.once('error', () => {
      this.connections.delete(lease.connectionId);
      this.options.connectionPool.release(clientId, lease.connectionId);
    });
  }

  private async handleMessage(
    connectionId: string,
    clientId: string,
    socket: WebSocket,
    message: RawData,
  ): Promise<void> {
    const decision = this.rateLimiter.consume(clientId);
    if (!decision.allowed) {
      socket.send(
        JSON.stringify({
          type: 'error',
          error: 'Rate limit exceeded',
          retryAfterMs: decision.retryAfterMs,
        }),
      );
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON payload' }));
      return;
    }

    try {
      const response = await this.options.onMessage(payload);
      socket.send(
        JSON.stringify({
          type: 'response',
          data: response,
        }),
      );
    } catch (err) {
      logger.warn('WebSocket message handling failed', {
        clientId,
        err: err instanceof Error ? err.message : String(err),
      });
      socket.send(
        JSON.stringify({
          type: 'error',
          error: 'Request handling failed',
        }),
      );
    }
  }
}

function resolveClientId(request: IncomingMessage): string {
  const header = request.headers['x-client-id'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  return request.socket.remoteAddress ?? 'anonymous';
}

function resolveQueryToken(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  const parsed = new URL(url, 'http://localhost');
  return parsed.searchParams.get('token') ?? undefined;
}
