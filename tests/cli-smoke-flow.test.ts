/**
 * tests/cli-smoke-flow.test.ts
 * Runs the smoke client (src/cli/smoke.ts) end to end in HTTP mode against an
 * in-process Streamable HTTP endpoint backed by a scripted hub, verifying the
 * client's protocol flow and failure reporting.
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { runSmoke } from '../src/cli/smoke';
import { defineTool } from '../src/adapters/mcp/define-tool';
import { StreamableHttpTransport } from '../src/transport/streamable-http';

const TOKEN = 'smoke-flow-test-token-at-least-32-characters';

interface Behaviour {
  failInstall?: boolean;
  dropTool?: string;
}

function scriptedHub(behaviour: Behaviour): { connect: (t: Transport) => Promise<void>; close: () => Promise<void> } {
  const server = new McpServer({ name: 'Universal Standard MCP Server', version: '9.9.9' });
  const entities: string[] = [];
  const ok = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    discover_capabilities: () => ok({ count: 1, tools: [] }),
    install_tool: () =>
      behaviour.failInstall === true
        ? { content: [{ type: 'text', text: 'Installation failed: nope' }], isError: true }
        : ok({ success: true, approvedVia: 'elicitation', actions: ['create_entities', 'read_graph'] }),
    uninstall_tool: () => ok({ success: true }),
    list_installed_tools: () => ok({ tools: [{ id: 'official:memory' }], count: 1 }),
    list_capability_actions: () => ok({ actions: [{ name: 'create_entities' }, { name: 'read_graph' }] }),
    execute_capability: (args) => {
      if (args['action'] === 'create_entities') {
        const params = args['params'] as { entities: Array<{ name: string }> };
        entities.push(...params.entities.map((e) => e.name));
        return ok({ created: true });
      }
      return ok({ entities });
    },
    get_hub_status: () => ok({ version: '9.9.9' }),
    manage_policy: () => ok({ policies: [] }),
    route_to_provider: () => ok({}),
  };
  for (const [name, handler] of Object.entries(tools)) {
    if (name === behaviour.dropTool) continue;
    defineTool(
      server,
      name,
      name,
      {
        toolId: z.string().optional(),
        action: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      (args) => Promise.resolve(handler(args as Record<string, unknown>) as never),
    );
  }
  return { connect: (t) => server.connect(t), close: () => server.close() };
}

async function withHub(behaviour: Behaviour, fn: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  const transport = new StreamableHttpTransport({
    app,
    config: {
      NODE_ENV: 'test',
      JWT_SECRET: 'jwt-secret-for-smoke-flow-tests-32-chars!',
      MCP_HTTP_PATH: '/mcp',
      MCP_AUTH_TOKEN: TOKEN,
      MCP_ALLOW_UNAUTHENTICATED: false,
      MCP_ALLOWED_HOSTS: undefined,
      MCP_MAX_SESSIONS: 5,
      MCP_SESSION_IDLE_TIMEOUT_MS: 60_000,
    },
    adapterFactory: () => scriptedHub(behaviour),
  });
  await transport.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  } finally {
    await transport.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const base = { mode: 'http' as const, token: TOKEN, approve: true, keep: false, serverEntry: '', timeoutMs: 10_000 };

let output: string[];
let write: jest.SpyInstance;
beforeEach(() => {
  output = [];
  write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
});
afterEach(() => write.mockRestore());

const steps = (): Array<{ step: string; ok: boolean }> => output.map((l) => JSON.parse(l) as { step: string; ok: boolean });

describe('runSmoke() over HTTP', () => {
  it('runs the full install → execute → uninstall flow', async () => {
    await withHub({}, (url) => runSmoke({ ...base, url, install: 'official:memory' }));
    expect(steps().map((s) => `${s.step}:${s.ok}`)).toEqual([
      'initialize:true',
      'tools/list:true',
      'get_hub_status:true',
      'discover_capabilities:true',
      'install_tool:true',
      'list_capability_actions:true',
      'execute_capability:create_entities:true',
      'execute_capability:read_graph:true',
      'uninstall_tool:true',
    ]);
  });

  it('keeps the tool and checks restored installs when asked', async () => {
    await withHub({}, (url) =>
      runSmoke({ ...base, url, install: 'official:memory', keep: true, expectInstalled: 'official:memory' }),
    );
    const names = steps().map((s) => s.step);
    expect(names).toContain('list_installed_tools');
    expect(names).not.toContain('uninstall_tool');
  });

  it('fails when a hub tool is missing', async () => {
    await withHub({ dropTool: 'manage_policy' }, async (url) => {
      await expect(runSmoke({ ...base, url })).rejects.toThrow('missing tools: manage_policy');
    });
  });

  it('fails when installation fails', async () => {
    await withHub({ failInstall: true }, async (url) => {
      await expect(runSmoke({ ...base, url, install: 'official:memory' })).rejects.toThrow('Installation failed: nope');
    });
  });

  it('requires a URL in HTTP mode', async () => {
    await expect(runSmoke({ ...base })).rejects.toThrow('--http requires a URL');
  });
});
