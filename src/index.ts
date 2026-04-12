import 'dotenv/config';
import { validateConfig, config } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { rootLogger } from './observability/logger';
import { auditLog } from './security/audit';

async function main(): Promise<void> {
  validateConfig();
  const server = new Server(config);
  // Register shutdown hooks in reverse-priority order (last registered = first to run)
  lifecycle.register('audit-flush', () => auditLog.flush());
  lifecycle.register('http-server', () => server.stop());
  lifecycle.start();
  await server.start();
  lifecycle.onReady();
}

main().catch((err: unknown) => {
  rootLogger.error('Fatal startup error', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
