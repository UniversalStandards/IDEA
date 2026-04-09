import { createLogger } from '../observability/logger';

const logger = createLogger('lifecycle');

interface ShutdownHook {
  name: string;
  fn: () => Promise<void>;
}


const SHUTDOWN_TIMEOUT_MS = 30_000;

export class LifecycleManager {
  private readonly hooks: ShutdownHook[] = [];
  private shuttingDown = false;

  register(name: string, shutdown: () => Promise<void>): void {
    this.hooks.push({ name, fn: shutdown });
    logger.debug('Shutdown hook registered', { name });
  }

  start(): void {
    const handler = (signal: string) => async (): Promise<void> => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      logger.info(`Received ${signal} — starting graceful shutdown`);
      await this.runShutdown();
    };

    process.on('SIGTERM', () => void handler('SIGTERM')());
    process.on('SIGINT', () => void handler('SIGINT')());

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { err: err.message, stack: err.stack });
      if (!this.shuttingDown) {
        this.shuttingDown = true;
        void this.runShutdown().then(() => process.exit(1));
      }
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    });

    logger.debug('Lifecycle manager started — signal handlers installed');
  }

  onReady(): void {
    logger.info('🚀 Hub is ready and accepting requests');
  }

  private async runShutdown(): Promise<void> {
    logger.info('Running shutdown hooks', { hookCount: this.hooks.length });

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timeout exceeded — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    forceExit.unref();

    // Run hooks in reverse registration order
    const reversed = [...this.hooks].reverse();
    for (const hook of reversed) {
      try {
        logger.debug('Running shutdown hook', { name: hook.name });
        await hook.fn();
        logger.debug('Shutdown hook complete', { name: hook.name });
      } catch (err) {
        logger.error('Shutdown hook failed', {
          name: hook.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    clearTimeout(forceExit);
    logger.info('All shutdown hooks complete — exiting cleanly');
    process.exit(0);
  }
}

export const lifecycle = new LifecycleManager();
