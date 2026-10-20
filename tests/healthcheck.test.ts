/**
 * tests/healthcheck.test.ts
 * Unit tests for the container HEALTHCHECK entry point.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { isStdioOnlyEnv, probe, runHealthcheck } from '../src/healthcheck';

function listen(status: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/health/live' ? status : 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('healthcheck', () => {
  it('passes without probing in stdio-only mode', async () => {
    expect(isStdioOnlyEnv({ MCP_TRANSPORT: 'stdio' })).toBe(true);
    await expect(runHealthcheck({ MCP_TRANSPORT: 'stdio', PORT: '1' })).resolves.toBe(0);
  });

  it('probes when stdio mode also serves HTTP', () => {
    expect(isStdioOnlyEnv({ MCP_TRANSPORT: 'stdio', STDIO_ENABLE_HTTP: 'true' })).toBe(false);
  });

  it('reports healthy when /health/live returns 200', async () => {
    const { server, port } = await listen(200);
    try {
      await expect(runHealthcheck({ MCP_TRANSPORT: 'http', PORT: String(port) })).resolves.toBe(0);
    } finally {
      server.close();
    }
  });

  it('reports unhealthy on a non-200 response', async () => {
    const { server, port } = await listen(503);
    try {
      await expect(probe(port)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it('reports unhealthy when nothing is listening', async () => {
    const { server, port } = await listen(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(runHealthcheck({ PORT: String(port) })).resolves.toBe(1);
  });

  it('times out a hung listener', async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(probe(port, 50)).resolves.toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('defaults to port 3000 when PORT is not numeric', async () => {
    await expect(runHealthcheck({ PORT: 'not-a-port' })).resolves.toBe(1);
  });
});
