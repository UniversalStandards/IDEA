import express, { type Express } from 'express';
import { createLogger } from '../observability/logger';
import { type Config } from '../config';
import { runtimeManager } from './runtime-manager';
import { TransportManager } from '../transport/index';

const logger = createLogger('server');

export class Server {
  private app: Express;
  private readonly transportManager: TransportManager;
  private readonly startedAt = Date.now();

  constructor(private readonly cfg: Config) {
    this.app = express();
    this.transportManager = new TransportManager({
      app: this.app,
      config: this.cfg,
    });
  }

  async start(): Promise<void> {
    logger.info('Starting server...');

    // ── Runtime initialization ──────────────────────────────────────────
    await runtimeManager.initialize();
    await this.transportManager.start();

    logger.info('Server startup complete', {
      port: this.cfg.PORT,
      transport: this.cfg.MCP_TRANSPORT,
    });
  }

  async stop(): Promise<void> {
    logger.info('Server stopping...');
    await this.transportManager.stop();
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
