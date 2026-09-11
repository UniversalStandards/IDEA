import 'dotenv/config';
import { validateConfig, config } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { auditLog } from './security/audit';
import { secretStore } from './security/secret-store';
import { createLogger } from './observability/logger';

const logger = createLogger('bootstrap');

async function main(): Promise<void> {
  validateConfig();
  const server = new Server(config);

  lifecycle.register('http-server', () => server.stop());
  lifecycle.register('audit-log', () => auditLog.flush());
  lifecycle.register('secret-store', () => {
    secretStore.clear();
    return Promise.resolve();
  });

  lifecycle.start();
  await server.start();
  lifecycle.onReady();
}

main().catch((err: unknown) => {
  logger.error('Fatal startup error', {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
