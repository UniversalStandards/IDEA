import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { versionMiddleware } from '../src/api/versioning/VersionMiddleware';

describe('versionMiddleware', () => {
  it('marks v1 requests as deprecated', async () => {
    const app = express();
    app.use('/api', versionMiddleware);
    app.get('/api/v1/ping', (req, res) => {
      res.json({ version: req.apiVersion });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const response = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/ping',
      method: 'GET',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['deprecation']).toBe('true');
    expect(response.body['version']).toBe('v1');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('negotiates version from Accept header', async () => {
    const app = express();
    app.use('/api', versionMiddleware);
    app.get('/api/v1/ping', (req, res) => {
      res.json({ version: req.apiVersion });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const response = await requestJson({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/v1/ping',
      method: 'GET',
      headers: {
        accept: 'application/vnd.hub.v2+json',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['deprecation']).toBeUndefined();
    expect(response.body['version']).toBe('v2');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

async function requestJson(options: http.RequestOptions): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
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
          headers: response.headers,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
      });
    });

    request.on('error', reject);
    request.end();
  });
}
