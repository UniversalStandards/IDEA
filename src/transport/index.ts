import type { Express } from 'express';
import type { Server as HttpServer } from 'http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '../observability/logger';
import type { Config } from '../config';
import { MCPAdapter } from '../adapters/mcp/index';
import { requestNormalizer } from '../normalization/request-normalizer';
import { runtimeManager } from '../core/runtime-manager';
import { HttpTransport } from './http';
import { ConnectionPool } from './pool';
import { ConnectionRateLimiter } from './middleware/rateLimit';
import { SseTransport } from './sse';
import { WsTransport } from './websocket';
import { GrpcTransport } from './grpc';
import { StreamableHttpTransport } from './streamable-http';
import type { HttpServerLike } from './http';
import { lifecycle } from '../core/lifecycle';
import { isStdioOnly } from '../config';

const logger = createLogger('transport-manager');

export type TransportName =
  | 'http'
  | 'http2'
  | 'sse'
  | 'websocket'
  | 'grpc'
  | 'stdio'
  | 'streamable-http';

export interface ITransport {
  readonly name: TransportName;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TransportManagerOptions {
  readonly app: Express;
  readonly config: Config;
}

export class TransportManager {
  private readonly connectionPool: ConnectionPool;
  private readonly rateLimiter: ConnectionRateLimiter;
  private readonly httpTransport: HttpTransport;
  private readonly transports: ITransport[] = [];

  constructor(private readonly options: TransportManagerOptions) {
    this.connectionPool = new ConnectionPool({
      maxConnectionsPerClient: options.config.TRANSPORT_MAX_CONNECTIONS_PER_CLIENT,
    });
    this.rateLimiter = new ConnectionRateLimiter({
      windowMs: options.config.RATE_LIMIT_WINDOW_MS,
      maxRequests: options.config.RATE_LIMIT_MAX_REQUESTS,
    });
    this.httpTransport = new HttpTransport({
      app: options.app,
      config: options.config,
      port: options.config.PORT,
      mode: options.config.MCP_TRANSPORT === 'http2' ? 'http2' : 'http',
    });
  }

  async start(): Promise<void> {
    const selected = this.options.config.MCP_TRANSPORT;

    // stdio-only: stdout/stdin are the MCP channel and no network listener is
    // opened, so several instances can run side by side (one per client) and
    // the process exits when the client disconnects.
    if (isStdioOnly(this.options.config)) {
      const stdio = new StdioTransportAdapter();
      await stdio.initialize();
      await stdio.start();
      this.transports.push(stdio);
      logger.info('Transport manager started', {
        transport: selected,
        activeTransports: this.transports.map((transport) => transport.name),
      });
      return;
    }

    await this.httpTransport.initialize();

    // MCP Streamable HTTP endpoint — mounted before the 404/error fallbacks.
    if (this.options.config.MCP_HTTP_ENABLED) {
      const mcpHttp = new StreamableHttpTransport({
        app: this.options.app,
        config: this.options.config,
      });
      await mcpHttp.initialize();
      await mcpHttp.start();
      this.transports.push(mcpHttp);
    }

    let deferredTransport: ITransport | undefined;

    if (selected === 'sse') {
      const sseTransport = new SseTransport({
        app: this.options.app,
        config: this.options.config,
        connectionPool: this.connectionPool,
        path: '/mcp/sse',
      });
      await sseTransport.initialize();
      this.transports.push(sseTransport);
    }

    this.httpTransport.attachFallbackHandlers();
    await this.httpTransport.start();
    this.transports.unshift(this.httpTransport);

    if (selected === 'websocket') {
      const server = this.httpTransport.getServer();
      assertHttpServer(server);
      deferredTransport = new WsTransport({
        server,
        config: this.options.config,
        connectionPool: this.connectionPool,
        rateLimiter: this.rateLimiter,
        path: '/mcp/ws',
        onMessage: async (payload: unknown): Promise<unknown> => {
          const request = requestNormalizer.normalize(payload, 'websocket');
          return runtimeManager.handleRequest(request);
        },
      });
    } else if (selected === 'grpc') {
      deferredTransport = new GrpcTransport({
        config: this.options.config,
        connectionPool: this.connectionPool,
        rateLimiter: this.rateLimiter,
        port: this.options.config.GRPC_PORT,
        onMessage: async (payload: unknown): Promise<unknown> => {
          const request = requestNormalizer.normalize(payload, 'grpc');
          return runtimeManager.handleRequest(request);
        },
        onStream: async (payload: unknown): Promise<Iterable<unknown>> => {
          const response = await runtimeManager.handleRequest(
            requestNormalizer.normalize(payload, 'grpc'),
          );
          return [response];
        },
      });
    } else if (selected === 'stdio') {
      deferredTransport = new StdioTransportAdapter();
    }

    if (deferredTransport) {
      await deferredTransport.initialize();
      await deferredTransport.start();
      this.transports.push(deferredTransport);
    }

    logger.info('Transport manager started', {
      transport: selected,
      httpMode: this.options.config.MCP_TRANSPORT === 'http2' ? 'http2' : 'http',
      activeTransports: this.transports.map((transport) => transport.name),
    });
  }

  async stop(): Promise<void> {
    const reversed = [...this.transports].reverse();
    for (const transport of reversed) {
      await transport.stop();
    }
    this.transports.length = 0;
    this.connectionPool.clear();
    logger.info('Transport manager stopped');
  }

  getHttpServer(): ReturnType<HttpTransport['getServer']> {
    return this.httpTransport.getServer();
  }
}

function assertHttpServer(server: HttpServerLike): asserts server is HttpServer {
  if ('setTimeout' in server) {
    return;
  }
  throw new Error('WebSocket transport requires an HTTP/1.1 server');
}

export class StdioTransportAdapter implements ITransport {
  readonly name = 'stdio' as const;
  private adapter?: MCPAdapter;
  private stopped = false;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly onClientDisconnect: (reason: string) => Promise<void> = (reason) =>
      lifecycle.shutdown(reason),
  ) {}

  initialize(): Promise<void> {
    this.adapter = new MCPAdapter();
    return Promise.resolve();
  }

  async start(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Stdio transport has not been initialized');
    }

    const transport = new StdioServerTransport(
      this.stdin as ConstructorParameters<typeof StdioServerTransport>[0],
      this.stdout as ConstructorParameters<typeof StdioServerTransport>[1],
    );
    await this.adapter.connect(transport);

    // MCP stdio lifecycle: the client ends the session by closing our stdin.
    // Without this the HTTP-free process would idle forever (orphaned
    // containers under `docker run -i --rm`, zombie processes under desktop
    // clients).
    const onEnd = (): void => {
      if (this.stopped) return;
      logger.info('stdio client disconnected (stdin closed)');
      void this.onClientDisconnect('MCP stdio client disconnected');
    };
    this.stdin.once('end', onEnd);
    this.stdin.once('close', onEnd);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.adapter?.close();
  }
}
