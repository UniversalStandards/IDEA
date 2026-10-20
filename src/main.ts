/**
 * src/main.ts
 * Process bootstrap, loaded by src/index.ts only after the configuration has
 * been validated (so a misconfiguration fails with one clear message instead
 * of an import-time stack trace).
 */

import { config, getEphemeralSecretNames } from './config';
import { lifecycle } from './core/lifecycle';
import { Server } from './core/server';
import { auditLog } from './security/audit';
import { secretStore } from './security/secret-store';
import { createLogger } from './observability/logger';

const logger = createLogger('bootstrap');

export async function main(): Promise<void> {
  const ephemeral = getEphemeralSecretNames();
  if (ephemeral.length > 0) {
    logger.warn('Generated per-process secrets for stdio-only mode (no network listener is open)', {
      secrets: ephemeral,
    });
  }
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

export function reportFatal(err: unknown): void {
  logger.error('Fatal startup error', {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}
