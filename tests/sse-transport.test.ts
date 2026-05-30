import * as http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import type { Config } from '../src/config';
import { ConnectionPool } from '../src/transport/pool';
import { SseTransport } from '../src/transport/sse';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX_REQUESTS: 10,
    TRANSPORT_MAX_CONNECTIONS_PER_CLIENT: 2,
    GRPC_PORT: 0,
    JWT_SECRET: 'test-secret-that-is-32-characters-long!!',
    MCP_TRANSPORT: 'sse',
    ...overrides,
  } as unknown as Config;
}

describe('SseTransport', () => {
  it('streams chunked events to connected clients', async () => {
    const app = express();
    const config = makeConfig();
    const token = jwt.sign({ sub: 'agent-1' }, config.JWT_SECRET);
    const sseTransport = new SseTransport({
      app,
      config,
      connectionPool: new ConnectionPool({ maxConnectionsPerClient: 2 }),
      path: '/events',
      heartbeatMs: 1_000,
    });

    await sseTransport.initialize();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const address = server.address() as AddressInfo;
    const received = await new Promise<string>((resolve, reject) => {
      let body = '';
      let published = false;

      const request = http.get(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/events?clientId=agent-1',
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;

            if (!published && body.includes('event: connected')) {
              published = true;
              sseTransport.publish({ hello: 'world' }, { clientId: 'agent-1', event: 'message' });
            }

            if (body.includes('"hello":"world"')) {
              response.destroy();
              resolve(body);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });

    expect(received).toContain('event: connected');
    expect(received).toContain('event: message');
    expect(received).toContain('"hello":"world"');

    await sseTransport.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
});
