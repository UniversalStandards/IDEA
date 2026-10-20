/**
 * src/healthcheck.ts
 * Container HEALTHCHECK entry point (`node dist/healthcheck.js`).
 *
 * - HTTP modes: probes GET /health/live on the local listener.
 * - stdio-only mode: there is no listener; the process being alive is the
 *   health signal (the container exits when the MCP client disconnects), so
 *   the check passes without probing.
 */

import http from 'http';

export function isStdioOnlyEnv(env: NodeJS.ProcessEnv): boolean {
  return env['MCP_TRANSPORT'] === 'stdio' && env['STDIO_ENABLE_HTTP'] !== 'true';
}

export function probe(port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health/live', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

export async function runHealthcheck(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (isStdioOnlyEnv(env)) return 0;
  const port = Number.parseInt(env['PORT'] ?? '3000', 10);
  return (await probe(Number.isFinite(port) ? port : 3000)) ? 0 : 1;
}

if (require.main === module) {
  void runHealthcheck().then((code) => process.exit(code));
}
