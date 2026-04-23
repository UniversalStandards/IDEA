import 'dotenv/config';
import { validateConfig, config } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { shutdownRedis } from './core/redis-client';

async function main(): Promise<void> {
  validateConfig();
  const server = new Server(config);
  lifecycle.register('redis', shutdownRedis);
  lifecycle.register('http-server', () => server.stop());
  lifecycle.start();
  await server.start();
  lifecycle.onReady();
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
