import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import * as http from 'http';
import * as http2 from 'http2';
import { createLogger } from '../observability/logger';
import type { Config } from '../config';
import { healthRouter } from '../api/health';
import { statusRouter } from '../api/status';
import { adminRouter } from '../api/admin-api';
import { createRestAdapter } from '../adapters/rest/index';
import { createHttpRateLimitMiddleware } from './middleware/rateLimit';
import type { ITransport } from './index';
import { createWebhookRouter } from '../api/webhooks/WebhookRouter';
import { createSseRouter } from '../api/streaming/SseRouter';
import { WsRouter } from '../api/streaming/WsRouter';
import { versionMiddleware } from '../api/versioning/VersionMiddleware';
import { createTenantRouter } from '../api/tenant/TenantRouter';

const logger = createLogger('http-transport');
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

export type HttpServerLike = http.Server | http2.Http2Server;

export interface HttpTransportOptions {
  readonly app: Express;
  readonly config: Config;
  readonly port?: number;
  readonly mode?: 'http' | 'http2';
}

export class HttpTransport implements ITransport {
  readonly name: 'http' | 'http2';
  private server: HttpServerLike | undefined;
  private initialized = false;
  private fallbackHandlersAttached = false;
  private readonly port: number;
  private readonly webhookRouter: express.Router;
  private readonly streamRouter: express.Router;
  private readonly tenantRouter: express.Router;
  private readonly wsRouter: WsRouter;

  constructor(private readonly options: HttpTransportOptions) {
    this.name = options.mode ?? 'http';
    this.port = options.port ?? options.config.PORT;
    this.webhookRouter = createWebhookRouter();
    this.streamRouter = createSseRouter({ jwtSecret: options.config.JWT_SECRET });
    this.tenantRouter = createTenantRouter({ jwtSecret: options.config.JWT_SECRET });
    this.wsRouter = new WsRouter({
      handlerOptions: {
        jwtSecret: options.config.JWT_SECRET,
        path: '/api/v1/ws',
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const corsOriginRaw = this.options.config.CORS_ORIGIN ?? '*';
    const isWildcard = corsOriginRaw === '*';
    const allowedOrigins = isWildcard
      ? new Set<string>()
      : new Set(corsOriginRaw.split(',').map((origin) => origin.trim()));

    this.options.app.use(helmet());
    this.options.app.use(
      cors({
        origin: (requestOrigin, callback) => {
          if (isWildcard || !requestOrigin || allowedOrigins.has(requestOrigin)) {
            callback(null, true);
            return;
          }
          callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: !isWildcard,
      }),
    );
    this.options.app.use(express.json({ limit: '10mb' }));
    this.options.app.use(express.urlencoded({ extended: true }));
    this.options.app.use(createHttpRateLimitMiddleware(this.options.config));
    this.options.app.use('/health', healthRouter);
    this.options.app.use('/status', statusRouter);
    this.options.app.use('/admin', adminRouter);
    this.options.app.use('/api', versionMiddleware);
    this.options.app.use('/api/v1', this.webhookRouter);
    this.options.app.use('/api/v1', this.streamRouter);
    this.options.app.use('/api/v1', this.wsRouter.router);
    this.options.app.use('/api/v1', this.tenantRouter);
    createRestAdapter(this.options.app);

    this.initialized = true;
  }

  attachFallbackHandlers(): void {
    if (this.fallbackHandlersAttached) {
      return;
    }

    this.options.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });
    this.options.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled request error', { err });
      res.status(500).json({ error: 'Internal server error' });
    });
    this.fallbackHandlersAttached = true;
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.fallbackHandlersAttached) {
      this.attachFallbackHandlers();
    }
    if (this.server) {
      return;
    }

    this.server =
      this.name === 'http2'
        ? http2.createServer({}, (request, response) => {
            // Express expects HTTP/1-style request/response objects; Node's HTTP/2
            // compatibility API is close enough for our route handling in cleartext mode.
            this.options.app(request as never, response as never);
          })
        : http.createServer(this.options.app);

    if (this.name === 'http') {
      this.wsRouter.attach(this.server as http.Server);
    }

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('HTTP server was not created'));
        return;
      }

      server.once('error', reject);
      server.listen(this.port, () => {
        server.off('error', reject);
        logger.info('HTTP transport listening', { port: this.port, mode: this.name });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      timeout.unref();

      const onAbort = (): void => {
        logger.warn('HTTP transport forced closed after graceful timeout');
        resolve();
      };

      abortController.signal.addEventListener('abort', onAbort, { once: true });
      server.close((err?: Error) => {
        clearTimeout(timeout);
        abortController.signal.removeEventListener('abort', onAbort);
        if (err) {
          reject(err);
          return;
        }
        logger.info('HTTP transport stopped');
        resolve();
      });
    });
  }

  getServer(): HttpServerLike {
    if (!this.server) {
      throw new Error('HTTP transport has not been started');
    }
    return this.server;
  }
}
