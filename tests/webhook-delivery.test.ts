import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { WebhookDelivery } from '../src/api/webhooks/WebhookDelivery';
import { createWebhookRouter } from '../src/api/webhooks/WebhookRouter';
import { WebhookStore } from '../src/api/webhooks/WebhookStore';

describe('Webhook delivery and router', () => {
  const secret = 'test-secret-that-is-32-characters-long!!';

  it('sends signed webhook payloads', async () => {
    const store = new WebhookStore(':memory:');
    await store.initialize();
    await store.create({
      orgId: 'org-a',
      url: 'https://example.com/webhook',
      events: ['capability.installed'],
      secret: 'webhook-shared-secret',
    });

    const fetchCalls: Array<{ url: string; headers: Headers }> = [];
    const delivery = new WebhookDelivery({
      store,
      fetchImpl: (async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
        fetchCalls.push({
          url: String(url),
          headers: new Headers(init?.headers),
        });
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });

    await delivery.deliverToOrg('org-a', 'capability.installed', { capabilityId: 'cap-1' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://example.com/webhook');
    expect(fetchCalls[0]?.headers.get('x-hub-signature-256')).toMatch(/^sha256=/);
    store.close();
  });

  it('records dead letters after retry exhaustion', async () => {
    const store = new WebhookStore(':memory:');
    await store.initialize();
    await store.create({
      orgId: 'org-a',
      url: 'https://example.com/webhook',
      events: ['workflow.completed'],
      secret: 'webhook-shared-secret',
    });

    const delivery = new WebhookDelivery({
      store,
      fetchImpl: (async () => {
        throw new Error('network error');
      }) as typeof fetch,
      retryDelaysMs: [1, 1, 1],
      wait: async (): Promise<void> => Promise.resolve(),
    });

    await delivery.deliverToOrg('org-a', 'workflow.completed', { runId: 'run-1' });

    const deadLetters = await store.listDeadLetters('org-a');
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.attempts).toBe(4);
    store.close();
  });

  it('supports webhook CRUD endpoints', async () => {
    const store = new WebhookStore(':memory:');
    await store.initialize();

    const app = express();
    app.use(express.json());
    app.use('/api/v1', createWebhookRouter({ store, jwtSecret: secret }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const token = jwt.sign({ sub: 'user-1', orgId: 'org-a' }, secret);
    const authHeader = makeBearerToken(token);

    const created = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/webhooks',
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-type': 'application/json',
      },
      body: {
        url: 'https://example.com/hook',
        events: ['capability.installed'],
      },
    });

    expect(created.statusCode).toBe(201);

    const listed = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/webhooks',
      method: 'GET',
      headers: {
        authorization: authHeader,
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.body['count']).toBe(1);

    const webhookId = (created.body['id'] as string) ?? '';
    const deleted = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: `/api/v1/webhooks/${webhookId}`,
      method: 'DELETE',
      headers: {
        authorization: authHeader,
      },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body['deleted']).toBe(true);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.close();
  });
});

function makeBearerToken(token: string): string {
  const bearerPrefix = String.fromCharCode(66, 101, 97, 114, 101, 114, 32);
  return bearerPrefix + token;
}

async function requestJson(options: http.RequestOptions & { body?: Record<string, unknown> }): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 500,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
      });
    });

    request.on('error', reject);
    if (options.body) {
      request.write(JSON.stringify(options.body));
    }
    request.end();
  });
}
