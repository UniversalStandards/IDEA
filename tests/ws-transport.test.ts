import * as http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import WebSocket, { type RawData } from 'ws';
import type { Config } from '../src/config';
import { ConnectionPool } from '../src/transport/pool';
import { WsTransport } from '../src/transport/websocket';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX_REQUESTS: 10,
    TRANSPORT_MAX_CONNECTIONS_PER_CLIENT: 2,
    GRPC_PORT: 0,
    JWT_SECRET: 'test-secret-that-is-32-characters-long!!',
    MCP_TRANSPORT: 'websocket',
    ...overrides,
  } as unknown as Config;
}

describe('WsTransport', () => {
  it('supports bidirectional JSON messaging', async () => {
    const app = express();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const wsTransport = new WsTransport({
      server,
      config: makeConfig(),
      connectionPool: new ConnectionPool({ maxConnectionsPerClient: 2 }),
      path: '/ws',
      onMessage: async (payload: unknown): Promise<unknown> => {
        const record = payload as Record<string, unknown>;
        return { echo: record['message'] };
      },
    });

    await wsTransport.start();

    const address = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${String(address.port)}/ws`);

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      client.on('message', (raw: RawData) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message['type'] === 'connected') {
          client.send(JSON.stringify({ message: 'ping' }));
          return;
        }

        if (message['type'] === 'response') {
          resolve(message);
        }
      });
      client.on('error', reject);
    });

    expect((response['data'] as Record<string, unknown>)['echo']).toBe('ping');

    client.close();
    await wsTransport.stop();
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
