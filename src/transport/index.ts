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
import type { HttpServerLike } from './http';

const logger = createLogger('transport-manager');

export type TransportName = 'http' | 'http2' | 'sse' | 'websocket' | 'grpc' | 'stdio';

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

    await this.httpTransport.initialize();

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

class StdioTransportAdapter implements ITransport {
  readonly name = 'stdio' as const;
  private adapter?: MCPAdapter;

  async initialize(): Promise<void> {
    this.adapter = new MCPAdapter();
  }

  async start(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Stdio transport has not been initialized');
    }

    const transport = new StdioServerTransport();
    await this.adapter.connect(transport);
  }

  async stop(): Promise<void> {
    await this.adapter?.getServer().close();
  }
}
