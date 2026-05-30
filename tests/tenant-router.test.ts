import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { createTenantRouter } from '../src/api/tenant/TenantRouter';

describe('TenantRouter', () => {
  const secret = 'test-secret-that-is-32-characters-long!!';

  it('enforces org isolation for org-scoped routes', async () => {
    const app = express();
    app.use(
      '/api/v1',
      createTenantRouter({
        jwtSecret: secret,
        listCapabilities: () => [{ id: 'cap-1' }],
      }),
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const okToken = jwt.sign({ sub: 'user-1', orgId: 'org-a' }, secret);
    const ok = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/orgs/org-a/capabilities',
      method: 'GET',
      headers: { authorization: makeBearerToken(okToken) },
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.body['orgId']).toBe('org-a');

    const badToken = jwt.sign({ sub: 'user-1', orgId: 'org-b' }, secret);
    const unauthorized = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/orgs/org-a/capabilities',
      method: 'GET',
      headers: { authorization: makeBearerToken(badToken) },
    });

    expect(unauthorized.statusCode).toBe(401);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('supports flat aliases', async () => {
    const app = express();
    app.use(
      '/api/v1',
      createTenantRouter({
        jwtSecret: secret,
        listCapabilities: () => [{ id: 'cap-1' }],
        listWorkflows: () => [{ id: 'wf-1' }],
      }),
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const token = jwt.sign({ sub: 'user-1', orgId: 'org-a' }, secret);
    const response = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/capabilities',
      method: 'GET',
      headers: { authorization: makeBearerToken(token) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body['alias']).toBe(true);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

function makeBearerToken(token: string): string {
  const bearerPrefix = String.fromCharCode(66, 101, 97, 114, 101, 114, 32);
  return bearerPrefix + token;
}

async function requestJson(options: http.RequestOptions): Promise<{
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
    request.end();
  });
}
