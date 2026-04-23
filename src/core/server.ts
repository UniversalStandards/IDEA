/**
 * src/core/server.ts
 * HTTP server + MCP transport orchestration.
 * Transport selection gated on MCP_TRANSPORT env var (not NODE_ENV).
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '../observability/logger';
import { type Config } from '../config';
import { healthRouter } from '../api/health';
import { statusRouter } from '../api/status';
import { adminRouter } from '../api/admin-api';
import { createRestAdapter } from '../adapters/rest/index';
import { MCPAdapter } from '../adapters/mcp/index';
import { runtimeManager } from './runtime-manager';
import { lifecycle } from './lifecycle';

// Augment Express Request to carry the correlation ID set by the global middleware.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const logger = createLogger('server');

/** Body size limit for the protected admin API — intentionally strict. */
const ADMIN_BODY_LIMIT = '1mb';
/** Body size limit for the general REST adapter — allows larger payloads. */
const DEFAULT_BODY_LIMIT = '10mb';

export class Server {
  private app: Express;
  private httpServer?: http.Server;
  private mcpAdapter?: MCPAdapter;
  private readonly startedAt = Date.now();

  constructor(private readonly cfg: Config) {
    this.app = express();
  }

  async start(): Promise<void> {
    logger.info('Starting server...');

    // ── Security middleware ────────────────────────────────────────────────
    // Explicit helmet directives — do not rely on defaults so that every
    // header is intentional and reviewable.
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'none'"],
            styleSrc: ["'none'"],
            imgSrc: ["'none'"],
            connectSrc: ["'self'"],
            fontSrc: ["'none'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'none'"],
            frameSrc: ["'none'"],
          },
        },
        // HSTS — force HTTPS for 1 year, including sub-domains, opt in to preload
        hsts: {
          maxAge: 31_536_000,
          includeSubDomains: true,
          preload: true,
        },
        // Prevent browsers from MIME-sniffing response content
        noSniff: true,
        // X-XSS-Protection: 0 — modern recommendation; rely on CSP instead
        xssFilter: true,
        // Additional sensible defaults kept explicit
        frameguard: { action: 'deny' },
        hidePoweredBy: true,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      }),
    );

    const corsOriginRaw = this.cfg.CORS_ORIGIN ?? '*';
    const isWildcard = corsOriginRaw === '*';
    const allowedOrigins: Set<string> = isWildcard
      ? new Set()
      : new Set(corsOriginRaw.split(',').map((s) => s.trim()));

    this.app.use(
      cors({
        origin: (requestOrigin, callback) => {
          if (isWildcard) { callback(null, true); return; }
          if (!requestOrigin || allowedOrigins.has(requestOrigin)) {
            callback(null, true);
          } else {
            callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
          }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
        exposedHeaders: ['X-Request-ID'],
        // credentials: true is only safe with a non-wildcard origin allowlist
        credentials: !isWildcard,
      }),
    );

    // ── Global X-Request-ID middleware ────────────────────────────────────
    // Propagate an incoming X-Request-ID or generate a new one. The ID is
    // attached to every response so clients can correlate logs.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const incoming = req.headers['x-request-id'];
      const requestId = (typeof incoming === 'string' && incoming.length > 0)
        ? incoming
        : randomUUID();
      res.setHeader('X-Request-ID', requestId);
      // Attach to request object for downstream handler logging (Express.Request augmentation above)
      req.requestId = requestId;
      next();
    });

    // ── Body parsers ──────────────────────────────────────────────────────
    // Admin routes use a tight 1 mb limit; the REST adapter uses 10 mb.
    // Mount per-prefix parsers before the routes so limits are enforced
    // at the correct boundary.
    this.app.use('/admin', express.json({ limit: ADMIN_BODY_LIMIT }));
    this.app.use('/admin', express.urlencoded({ extended: true, limit: ADMIN_BODY_LIMIT }));
    this.app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
    this.app.use(express.urlencoded({ extended: true }));

    // ── Rate limiting — driven by config vars (AGENTS.md 4.2) ────────────────
    const limiter = rateLimit({
      windowMs: this.cfg.RATE_LIMIT_WINDOW_MS,
      max: this.cfg.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    });
    this.app.use(limiter);

    // ── Route mounting ──────────────────────────────────────────────────
    this.app.use('/health', healthRouter);
    this.app.use('/status', statusRouter);
    this.app.use('/admin', adminRouter);

    // REST API adapter mounts its own routes onto the app
    createRestAdapter(this.app);

    // ── Runtime initialization ──────────────────────────────────────────
    await runtimeManager.initialize();

    // ── HTTP server ─────────────────────────────────────────────────────
    await new Promise<void>((resolve, reject) => {
      this.httpServer = this.app.listen(this.cfg.PORT, () => {
        logger.info(`HTTP server listening on port ${this.cfg.PORT}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });

    // ── MCP transport — gated on MCP_TRANSPORT env var (AGENTS.md 1.6) ─────
    this.mcpAdapter = new MCPAdapter();

    if (this.cfg.MCP_TRANSPORT === 'stdio') {
      // stdio: attach to process stdin/stdout for CLI / Claude Desktop usage
      try {
        const stdioTransport = new StdioServerTransport();
        await this.mcpAdapter.connect(stdioTransport);
        logger.info('MCP adapter connected via stdio');
      } catch (err) {
        logger.warn('MCP stdio transport connection failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (this.cfg.MCP_TRANSPORT === 'sse') {
      // SSE: each GET /mcp/sse request gets its own transport + adapter instance
      this.app.get('/mcp/sse', async (req: Request, res: Response) => {
        try {
          // Dynamically import SSEServerTransport to avoid loading it in stdio mode
          const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
          const sseTransport = new SSEServerTransport('/mcp/messages', res);
          const adapter = new MCPAdapter();
          await adapter.connect(sseTransport);
          logger.info('MCP SSE client connected', { ip: req.ip });
        } catch (err) {
          logger.warn('MCP SSE connection failed', {
            err: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            res.status(500).json({ error: 'MCP SSE connection failed' });
          }
        }
      });
      logger.info('MCP SSE endpoint mounted at GET /mcp/sse');
    } else {
      logger.info('MCP transport mode: http (REST/Admin API only)');
    }

    // ── Fallback 404 + global error handler ─────────────────────────
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled request error', { err });
      res.status(500).json({ error: 'Internal server error' });
    });

    // ── Lifecycle registration ───────────────────────────────────────
    lifecycle.register('runtime-manager', () => runtimeManager.shutdown());

    logger.info('Server startup complete', {
      port: this.cfg.PORT,
      transport: this.cfg.MCP_TRANSPORT,
    });
  }

  async stop(): Promise<void> {
    logger.info('Server stopping...');

    if (this.mcpAdapter) {
      try {
        await this.mcpAdapter.getServer().close();
      } catch (err) {
        logger.warn('MCP adapter close failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        // Force-resolve after 10s if graceful drain doesn't finish
        const forceTimeout = setTimeout(() => {
          logger.warn('HTTP server forced close after 10s timeout');
          resolve();
        }, 10_000);
        forceTimeout.unref();

        this.httpServer!.close(() => {
          clearTimeout(forceTimeout);
          logger.info('HTTP server closed gracefully');
          resolve();
        });
      });
    }

    await runtimeManager.shutdown();
    logger.info('Server stopped', { uptimeMs: Date.now() - this.startedAt });
  }

  getApp(): Express {
    return this.app;
  }

  getUptimeMs(): number {
    return Date.now() - this.startedAt;
  }
}
