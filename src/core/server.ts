import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import * as http from 'http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '../observability/logger';
import { Config } from '../config';
import { healthRouter } from '../api/health';
import { statusRouter } from '../api/status';
import { adminRouter } from '../api/admin-api';
import { createRestAdapter } from '../adapters/rest/index';
import { MCPAdapter } from '../adapters/mcp/index';
import { runtimeManager } from './runtime-manager';
import { lifecycle } from './lifecycle';

const logger = createLogger('server');

export class Server {
  private app: Express;
  private httpServer?: http.Server;
  private mcpAdapter?: MCPAdapter;

  constructor(private readonly cfg: Config) {
    this.app = express();
  }

  async start(): Promise<void> {
    logger.info('Starting server...');

    // Core middleware
    this.app.use(helmet());

    const corsOriginRaw = this.cfg.CORS_ORIGIN ?? '*';
    const isWildcard = corsOriginRaw === '*';
    const allowedOrigins: Set<string> = isWildcard
      ? new Set()
      : new Set(corsOriginRaw.split(',').map((s) => s.trim()));

    this.app.use(
      cors({
        origin: (requestOrigin, callback) => {
          if (isWildcard) {
            callback(null, true);
            return;
          }
          // Allow requests with no origin (e.g. server-to-server, curl)
          if (!requestOrigin || allowedOrigins.has(requestOrigin)) {
            callback(null, true);
          } else {
            callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
          }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: !isWildcard,
      }),
    );

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    });
    this.app.use(limiter);

    // Mount routers
    this.app.use('/health', healthRouter);
    this.app.use('/status', statusRouter);
    this.app.use('/admin', adminRouter);

    // REST API adapter
    createRestAdapter(this.app);

    // Initialize runtime
    await runtimeManager.initialize();

    // Start HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer = this.app.listen(this.cfg.PORT, () => {
        logger.info(`HTTP server listening on port ${this.cfg.PORT}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });

    // Setup MCP adapter with stdio transport
    this.mcpAdapter = new MCPAdapter();
    const stdioTransport = new StdioServerTransport();

    // Only connect stdio in non-test environments to avoid corrupting test output
    if (process.env['NODE_ENV'] !== 'test') {
      try {
        await this.mcpAdapter.connect(stdioTransport);
        logger.info('MCP adapter connected via stdio');
      } catch (err) {
        logger.warn('MCP stdio transport connection failed (may be expected in HTTP-only mode)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Register shutdown hooks
    lifecycle.register('runtime-manager', () => runtimeManager.shutdown());

    logger.info('Server startup complete', { port: this.cfg.PORT });
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
        this.httpServer!.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
        // Force close after 10s
        setTimeout(() => resolve(), 10_000).unref();
      });
    }

    await runtimeManager.shutdown();
    logger.info('Server stopped');
  }

  getApp(): Express {
    return this.app;
  }
}
