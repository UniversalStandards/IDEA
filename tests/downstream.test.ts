/**
 * tests/downstream.test.ts
 * Tests for src/adapters/mcp/downstream.ts — the hub's client connections to
 * installed MCP servers. Integration cases spawn a real stdio MCP server
 * (tests/fixtures/echo-mcp-server.js); lifecycle cases use injected fakes.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn() },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  DownstreamClientManager,
  DownstreamError,
  normalizeCallResult,
  type DownstreamClient,
} from '../src/adapters/mcp/downstream';
import type { ToolLaunchSpec } from '../src/provisioning/runtime-registrar';

const FIXTURE = path.join(__dirname, 'fixtures', 'echo-mcp-server.js');

let workDir: string;
const managers: DownstreamClientManager[] = [];

function spec(over: Partial<ToolLaunchSpec> = {}): ToolLaunchSpec {
  return {
    command: process.execPath,
    args: [FIXTURE],
    cwd: workDir,
    env: { FIXTURE_VAR: 'scoped-value' },
    timeoutMs: 15_000,
    ...over,
  };
}

function manager(resolve: (id: string) => ToolLaunchSpec | undefined, extra: Partial<ConstructorParameters<typeof DownstreamClientManager>[0]> = {}): DownstreamClientManager {
  const m = new DownstreamClientManager({ resolveLaunchSpec: resolve, idleTimeoutMs: 60_000, connectTimeoutMs: 20_000, ...extra });
  managers.push(m);
  return m;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-'));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('DownstreamClientManager (real stdio server)', () => {
  it('lists tools, calls them, and isolates the child environment', async () => {
    process.env['JWT_SECRET'] = 'hub-secret-that-must-not-leak-to-tools';
    try {
      const m = manager((id) => (id === 'fixture' ? spec() : undefined));

      const tools = await m.listTools('fixture');
      expect(tools.map((t) => t.name)).toEqual(['echo', 'env', 'fail']);
      expect(m.isConnected('fixture')).toBe(true);
      expect(m.connectedToolIds()).toEqual(['fixture']);

      await expect(m.callTool('fixture', 'echo', { text: 'hi' })).resolves.toEqual({
        content: [{ type: 'text', text: 'echo:hi' }],
      });

      const envResult = await m.callTool('fixture', 'env', {});
      const first = envResult.content[0];
      const reported = JSON.parse(first?.type === 'text' ? first.text : '{}') as Record<string, unknown>;
      expect(reported['jwtSecret']).toBeNull();
      expect(reported['fixtureVar']).toBe('scoped-value');
      expect(fs.realpathSync(String(reported['cwd']))).toBe(fs.realpathSync(workDir));

      const failed = await m.callTool('fixture', 'fail', {});
      expect(failed.isError).toBe(true);

      expect((await m.describeTool('fixture', 'fail'))?.annotations).toMatchObject({ destructiveHint: true });
      expect(await m.describeTool('fixture', 'missing')).toBeUndefined();

      await m.close('fixture');
      expect(m.isConnected('fixture')).toBe(false);
      await m.close('fixture');
    } finally {
      delete process.env['JWT_SECRET'];
    }
  }, 30_000);

  it('reports an unregistered tool', async () => {
    const m = manager(() => undefined);
    await expect(m.listTools('nope')).rejects.toMatchObject({ code: 'NOT_REGISTERED' });
  });

  it('reports a missing runtime clearly', async () => {
    const m = manager(() => spec({ command: 'definitely-not-an-installed-runtime-xyz', args: [] }));
    const err = await m.listTools('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownstreamError);
    expect((err as DownstreamError).code).toBe('RUNTIME_MISSING');
    expect((err as Error).message).toContain("Runtime 'definitely-not-an-installed-runtime-xyz' is not available");
    expect(m.isConnected('x')).toBe(false);
  }, 30_000);

  it('reports a server that exits during startup', async () => {
    const m = manager(() => spec({ args: ['-e', 'process.exit(3)'] }), { connectTimeoutMs: 5_000 });
    await expect(m.listTools('x')).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
  }, 30_000);
});

describe('DownstreamClientManager (lifecycle)', () => {
  interface Fake extends DownstreamClient {
    connect: jest.Mock;
    listTools: jest.Mock;
    callTool: jest.Mock;
    close: jest.Mock;
  }

  function fakeClient(): Fake {
    const client: Fake = {
      connect: jest.fn().mockResolvedValue(undefined),
      listTools: jest
        .fn()
        .mockResolvedValueOnce({ tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'p2' })
        .mockResolvedValue({ tools: [{ name: 'b', inputSchema: {} }] }),
      callTool: jest.fn().mockResolvedValue({ toolResult: { legacy: true } }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    return client;
  }

  const transport = (): Transport => ({ start: jest.fn(), send: jest.fn(), close: jest.fn() }) as unknown as Transport;

  it('follows pagination and normalizes legacy results', async () => {
    const client = fakeClient();
    const m = manager(() => spec(), { clientFactory: () => client, transportFactory: transport });

    expect((await m.listTools('t')).map((t) => t.name)).toEqual(['a', 'b']);
    expect(client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'p2' }, { timeout: 15_000 });
    await expect(m.callTool('t', 'a', {})).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ legacy: true }, null, 2) }],
    });
  });

  it('shares one connection between concurrent first calls', async () => {
    const factory = jest.fn(fakeClient);
    const m = manager(() => spec(), { clientFactory: factory, transportFactory: transport });
    await Promise.all([m.callTool('t', 'a', {}), m.callTool('t', 'a', {}), m.callTool('t', 'a', {})]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reaps idle connections but never one with a call in flight', async () => {
    let now = 1_000;
    const client = fakeClient();
    let release: (() => void) | undefined;
    client.callTool.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ content: [] }))),
    );
    const m = manager(() => spec(), {
      clientFactory: () => client,
      transportFactory: transport,
      idleTimeoutMs: 10_000,
      now: () => now,
    });

    const inFlight = m.callTool('t', 'a', {});
    await new Promise((r) => setImmediate(r));
    now += 60_000;
    await expect(m.reapIdle()).resolves.toBe(0);

    release?.();
    await inFlight;
    now += 60_000;
    await expect(m.reapIdle()).resolves.toBe(1);
    expect(client.close).toHaveBeenCalled();
    expect(m.isConnected('t')).toBe(false);
  });

  it('evicts a connection whose server exits', async () => {
    const client = fakeClient();
    const m = manager(() => spec(), { clientFactory: () => client, transportFactory: transport });
    await m.callTool('t', 'a', {});
    client.onclose?.();
    expect(m.isConnected('t')).toBe(false);
  });

  it('wraps transport construction failures', async () => {
    const m = manager(() => spec(), {
      clientFactory: fakeClient,
      transportFactory: () => {
        throw Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(m.listTools('t')).rejects.toMatchObject({ code: 'RUNTIME_MISSING' });
  });

  it('closes everything and tolerates close errors', async () => {
    const client = fakeClient();
    client.close.mockRejectedValue(new Error('already closed'));
    const m = manager(() => spec(), { clientFactory: () => client, transportFactory: transport });
    m.startReaper();
    m.startReaper();
    await m.callTool('t', 'a', {});
    await expect(m.closeAll()).resolves.toBeUndefined();
    expect(m.connectedToolIds()).toEqual([]);
  });

  it('counts failed calls and rethrows', async () => {
    const client = fakeClient();
    client.callTool.mockRejectedValue(new Error('request timed out'));
    const m = manager(() => spec(), { clientFactory: () => client, transportFactory: transport });
    await expect(m.callTool('t', 'a', {})).rejects.toThrow('request timed out');
  });
});

describe('normalizeCallResult()', () => {
  it('passes standard results through and wraps unknown shapes', () => {
    const standard = { content: [{ type: 'text', text: 'x' }], isError: false };
    expect(normalizeCallResult(standard)).toBe(standard);
    expect(normalizeCallResult({ weird: 1 })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ weird: 1 }, null, 2) }],
    });
  });
});
