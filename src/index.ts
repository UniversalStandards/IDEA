import 'dotenv/config';
import { validateConfig, config } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { createLogger } from './observability/logger';
import { auditLog } from './security/audit';

const logger = createLogger('index');

async function main(): Promise<void> {
  validateConfig();
  const server = new Server(config);
  lifecycle.register('http-server', () => server.stop());
  lifecycle.register('audit-log', () => auditLog.flush());
  lifecycle.start();
  await server.start();
  lifecycle.onReady();
}

main().catch((err: unknown) => {
  logger.error('Fatal startup error', {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
