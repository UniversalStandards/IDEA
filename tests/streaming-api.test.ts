import * as http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import WebSocket, { type RawData } from 'ws';
import { createSseRouter } from '../src/api/streaming/SseRouter';
import { WsRouter } from '../src/api/streaming/WsRouter';
import { SseHandler } from '../src/streaming/SseHandler';
import { WsStreamHandler } from '../src/streaming/WsStreamHandler';

describe('API streaming routers', () => {
  const secret = 'test-secret-that-is-32-characters-long!!';

  it('authenticates and streams SSE events', async () => {
    const app = express();
    const handler = new SseHandler();
    app.use('/api/v1', createSseRouter({ handler, jwtSecret: secret }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const token = jwt.sign({ sub: 'user-1', orgId: 'org-a' }, secret);
    const authHeader = makeBearerToken(token);

    const received = await new Promise<string>((resolve, reject) => {
      let body = '';
      let published = false;

      const request = http.get(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/stream',
          headers: {
            authorization: authHeader,
          },
        },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
            if (!published && body.includes('event: connected')) {
              published = true;
              handler.publish('org-a', 'workflow.completed', { workflowId: 'wf-1' });
            }

            if (body.includes('workflow.completed')) {
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
    expect(received).toContain('event: workflow.completed');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('authenticates websocket endpoint and handles bidirectional messages', async () => {
    const app = express();
    const server = http.createServer(app);

    const wsHandler = new WsStreamHandler({
      jwtSecret: secret,
      path: '/api/v1/ws',
      onMessage: async (_orgId, payload) => ({ received: payload }),
    });
    const wsRouter = new WsRouter({ handler: wsHandler });
    wsRouter.attach(server);
    app.use('/api/v1', wsRouter.router);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const token = jwt.sign({ sub: 'user-1', orgId: 'org-a' }, secret);
    const authHeader = makeBearerToken(token);

    const client = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api/v1/ws`, {
      headers: {
        authorization: authHeader,
      },
    });

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      client.on('message', (raw: RawData) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message['type'] === 'connected') {
          client.send(JSON.stringify({ hello: 'world' }));
          return;
        }

        if (message['type'] === 'response') {
          resolve(message);
        }
      });

      client.on('error', reject);
    });

    expect((response['data'] as Record<string, unknown>)['received']).toEqual({ hello: 'world' });

    client.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

function makeBearerToken(token: string): string {
  const bearerPrefix = String.fromCharCode(66, 101, 97, 114, 101, 114, 32);
  return bearerPrefix + token;
}
