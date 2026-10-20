/**
 * tests/streamable-http.test.ts
 * Integration tests for src/transport/streamable-http.ts: a real Express app
 * and HTTP listener, driven by the MCP SDK's Streamable HTTP client.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn() },
}));

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  StreamableHttpTransport,
  authorizeMcpRequest,
  type McpSessionAdapter,
  type StreamableHttpConfig,
} from '../src/transport/streamable-http';

const TOKEN = 'static-mcp-token-for-tests-at-least-32-chars';
const JWT_SECRET = 'jwt-secret-for-streamable-http-tests-32+';

function baseConfig(over: Partial<StreamableHttpConfig> = {}): StreamableHttpConfig {
  return {
    NODE_ENV: 'test',
    JWT_SECRET,
    MCP_HTTP_PATH: '/mcp',
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOW_UNAUTHENTICATED: false,
    MCP_ALLOWED_HOSTS: undefined,
    MCP_MAX_SESSIONS: 10,
    MCP_SESSION_IDLE_TIMEOUT_MS: 60_000,
    ...over,
  };
}

function pingAdapter(): McpSessionAdapter {
  const server = new McpServer({ name: 'test-hub', version: '1.0.0' });
  server.registerTool('ping', { description: 'Ping', inputSchema: {} }, () =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'pong' }] }),
  );
  return {
    connect: (t: Transport) => server.connect(t),
    close: () => server.close(),
  };
}

interface Harness {
  url: string;
  transport: StreamableHttpTransport;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function start(cfg: StreamableHttpConfig, now?: () => number, listenPort = 0): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const transport = new StreamableHttpTransport({ app, config: cfg, adapterFactory: pingAdapter, ...(now ? { now } : {}) });
  await transport.initialize();
  await transport.initialize();
  await transport.start();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${cfg.MCP_HTTP_PATH}`,
    transport,
    close: async () => {
      await transport.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const t = new StreamableHTTPClientTransport(new URL(url), {
    ...(token !== undefined ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(t as unknown as Transport);
  return client;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('authorizeMcpRequest()', () => {
  const cfg = { NODE_ENV: 'production' as const, JWT_SECRET, MCP_AUTH_TOKEN: TOKEN, MCP_ALLOW_UNAUTHENTICATED: false };

  it('accepts the static token and JWTs signed with JWT_SECRET', () => {
    expect(authorizeMcpRequest(`Bearer ${TOKEN}`, cfg)).toBe('ok');
    expect(authorizeMcpRequest(`Bearer ${jwt.sign({ sub: 'svc' }, JWT_SECRET)}`, cfg)).toBe('ok');
  });

  it('rejects wrong tokens, worker-session JWTs, and missing credentials', () => {
    expect(authorizeMcpRequest('Bearer wrong', cfg)).toBe('unauthorized');
    expect(authorizeMcpRequest(`Bearer ${jwt.sign({ scope: 'worker-session' }, JWT_SECRET)}`, cfg)).toBe('unauthorized');
    expect(authorizeMcpRequest(undefined, cfg)).toBe('unauthorized');
    expect(authorizeMcpRequest('Basic abc', cfg)).toBe('unauthorized');
  });

  it('is open without a token only outside production or when explicitly allowed', () => {
    const noToken = { ...cfg, MCP_AUTH_TOKEN: undefined };
    expect(authorizeMcpRequest(undefined, { ...noToken, NODE_ENV: 'development' })).toBe('ok');
    expect(authorizeMcpRequest(undefined, noToken)).toBe('unauthorized');
    expect(authorizeMcpRequest(undefined, { ...noToken, MCP_ALLOW_UNAUTHENTICATED: true })).toBe('ok');
  });
});

describe('StreamableHttpTransport', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('serves a full MCP session to an authenticated client', async () => {
    h = await start(baseConfig());
    const client = await connect(h.url, TOKEN);

    expect(client.getServerVersion()).toMatchObject({ name: 'test-hub' });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
    expect(await client.callTool({ name: 'ping', arguments: {} })).toMatchObject({ content: [{ text: 'pong' }] });
    expect(h.transport.getSessionCount()).toBe(1);

    await client.close();
  });

  it('closes the session on DELETE', async () => {
    h = await start(baseConfig());
    const client = await connect(h.url, TOKEN);
    const t = (client as unknown as { _transport: StreamableHTTPClientTransport })._transport;
    await t.terminateSession();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.transport.getSessionCount()).toBe(0);
    await client.close();
  });

  it('rejects unauthenticated requests with 401 and a Bearer challenge', async () => {
    h = await start(baseConfig());
    const res = await post(h.url, INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp"');
    expect(await res.json()).toMatchObject({ error: { code: -32001 } });
  });

  it('returns 404 for an unknown session so clients re-initialize', async () => {
    h = await start(baseConfig());
    const res = await post(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': 'not-a-session',
    });
    expect(res.status).toBe(404);
    const get = await fetch(h.url, { headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'nope' } });
    expect(get.status).toBe(404);
  });

  it('returns 400 for non-initialize requests without a session', async () => {
    h = await start(baseConfig());
    const res = await post(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
    const get = await fetch(h.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(400);
  });

  it('returns 503 when the session cap is reached', async () => {
    h = await start(baseConfig({ MCP_MAX_SESSIONS: 1 }));
    const first = await connect(h.url, TOKEN);
    const res = await post(h.url, INIT, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    await first.close();
  });

  it('reaps sessions idle past MCP_SESSION_IDLE_TIMEOUT_MS', async () => {
    let now = 1_000_000;
    h = await start(baseConfig({ MCP_SESSION_IDLE_TIMEOUT_MS: 60_000 }), () => now);
    const client = await connect(h.url, TOKEN);
    expect(await h.transport.reapIdleSessions()).toBe(0);
    now += 120_000;
    expect(await h.transport.reapIdleSessions()).toBe(1);
    expect(h.transport.getSessionCount()).toBe(0);
    await client.close();
  });

  it('enforces the Host allowlist when MCP_ALLOWED_HOSTS is set', async () => {
    h = await start(baseConfig({ MCP_ALLOWED_HOSTS: 'hub.example.com' }));
    const res = await post(h.url, INIT, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(h.transport.getSessionCount()).toBe(0);
  });

  it('accepts requests whose Host is on the allowlist', async () => {
    const port = await freePort();
    h = await start(baseConfig({ MCP_ALLOWED_HOSTS: ` 127.0.0.1:${port} , other.example ` }), undefined, port);
    const client = await connect(h.url, TOKEN);
    expect(h.transport.getSessionCount()).toBe(1);
    await client.close();
  });
});
