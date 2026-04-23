import 'dotenv/config';
import { validateConfig, config } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { connectDatabase, disconnectDatabase } from './core/database';

async function main(): Promise<void> {
  validateConfig();

  if (config.DATABASE_URL) {
    await connectDatabase();
    lifecycle.register('database', disconnectDatabase);
  }

  const server = new Server(config);
  lifecycle.register('http-server', () => server.stop());
  lifecycle.start();
  await server.start();
  lifecycle.onReady();
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
