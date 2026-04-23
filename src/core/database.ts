/**
 * src/core/database.ts
 * Singleton PrismaClient with lifecycle management.
 * Import `db` wherever you need database access.
 */

import { PrismaClient } from '@prisma/client';
import { createLogger } from '../observability/logger';

const logger = createLogger('database');

// ── Singleton ─────────────────────────────────────────────────────────────────

let _client: PrismaClient | null = null;

/**
 * Return the shared PrismaClient instance, creating it on first call.
 * The client is lazy-connected — the first query will open the connection.
 */
export function getDatabase(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient({
      log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
      ],
    });

    _client.$on('error', (e) => {
      logger.error('Prisma client error', { message: e.message, target: e.target });
    });

    _client.$on('warn', (e) => {
      logger.warn('Prisma client warning', { message: e.message, target: e.target });
    });
  }
  return _client;
}

/**
 * Typed database accessor. Prefer this over calling getDatabase() directly in
 * application code so that TypeScript can fully resolve all Prisma model types.
 */
export function db(): PrismaClient {
  return getDatabase();
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

/**
 * Gracefully disconnect the Prisma client.
 * Register this with the LifecycleManager in src/index.ts.
 */
export async function disconnectDatabase(): Promise<void> {
  if (_client) {
    logger.info('Disconnecting Prisma client...');
    await _client.$disconnect();
    _client = null;
    logger.info('Prisma client disconnected');
  }
}

/**
 * Connect explicitly (optional — Prisma auto-connects on first query).
 * Useful for validating the DATABASE_URL at startup.
 */
export async function connectDatabase(): Promise<void> {
  logger.info('Connecting to database...');
  await getDatabase().$connect();
  logger.info('Database connection established');
}
