/**
 * Tests for ToolClient and ToolClientPool (src/core/mcp-client.ts).
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), gauge: jest.fn(), histogram: jest.fn() },
}));

// MCP SDK mocks — factories use jest.fn() directly; per-test implementation is
// set via MockClient.mockImplementation() in beforeEach.
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../package.json', () => ({ version: '0.1.0' }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolClient, ToolClientPool } from '../src/core/mcp-client';
import type { RegisteredTool } from '../src/provisioning/runtime-registrar';

const MockClient = Client as jest.MockedClass<typeof Client>;
const MockStdioTransport = StdioClientTransport as jest.MockedClass<typeof StdioClientTransport>;

// ── helpers ──────────────────────────────────────────────────────────────────

const defaultConfig = { args: [], env: {}, workingDir: '/work', timeout: 30_000 };

function makeRegistered(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    tool: {
      id: 'tool-1',
      name: 'test-tool',
      version: '1.0.0',
      description: 'A test tool',
      source: 'local',
      capabilities: [],
      tags: [],
      installCommand: 'node server.js',
    },
    config: { ...defaultConfig },
    registeredAt: new Date(),
    status: 'running',
    ...overrides,
  };
}

/** Build a fresh set of mock SDK client methods and wire MockClient to return them. */
function setupClientMocks(): {
  mockConnect: jest.Mock;
  mockCallTool: jest.Mock;
  mockListTools: jest.Mock;
  mockClose: jest.Mock;
} {
  const mockConnect = jest.fn().mockResolvedValue(undefined);
  const mockCallTool = jest.fn();
  const mockListTools = jest.fn();
  const mockClose = jest.fn().mockResolvedValue(undefined);

  MockClient.mockImplementation(
    () =>
      ({
        connect: mockConnect,
        callTool: mockCallTool,
        listTools: mockListTools,
        close: mockClose,
      }) as unknown as Client,
  );

  return { mockConnect, mockCallTool, mockListTools, mockClose };
}

// ── ToolClient ────────────────────────────────────────────────────────────────

describe('ToolClient', () => {
  let mocks: ReturnType<typeof setupClientMocks>;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = setupClientMocks();
  });

  describe('callTool', () => {
    it('connects and calls the SDK callTool on first use', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });
      const client = new ToolClient(makeRegistered());
      const result = await client.callTool('greet', { name: 'world' });
      expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
      expect(mocks.mockCallTool).toHaveBeenCalledWith(
        { name: 'greet', arguments: { name: 'world' } },
        undefined,
        undefined,
      );
      expect(result.content[0]!.text).toBe('hi');
    });

    it('reuses the existing connection on a second call (connect called once)', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const client = new ToolClient(makeRegistered());
      await client.callTool('tool-a', {});
      await client.callTool('tool-b', {});
      expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
      expect(mocks.mockCallTool).toHaveBeenCalledTimes(2);
    });

    it('passes timeoutMs to the SDK call when provided', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const client = new ToolClient(makeRegistered());
      await client.callTool('t', {}, 5000);
      expect(mocks.mockCallTool).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        { timeout: 5000 },
      );
    });

    it('marks as disconnected and re-connects after an SDK error', async () => {
      const sdkError = new Error('connection lost');
      mocks.mockCallTool
        .mockRejectedValueOnce(sdkError)
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      const client = new ToolClient(makeRegistered());

      await expect(client.callTool('t', {})).rejects.toThrow('connection lost');

      // Second call must reconnect
      await client.callTool('t', {});
      expect(mocks.mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('listTools', () => {
    it('connects, calls listTools, and returns mapped ToolInfo[]', async () => {
      mocks.mockListTools.mockResolvedValue({
        tools: [
          { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
        ],
      });
      const client = new ToolClient(makeRegistered());
      const tools = await client.listTools();
      expect(mocks.mockConnect).toHaveBeenCalledTimes(1);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'search',
        description: 'Search the web',
        inputSchema: { type: 'object' },
      });
    });

    it('omits description field when tool.description is undefined (exactOptionalPropertyTypes)', async () => {
      mocks.mockListTools.mockResolvedValue({
        tools: [{ name: 'noop', inputSchema: {} }],
      });
      const client = new ToolClient(makeRegistered());
      const tools = await client.listTools();
      expect(Object.prototype.hasOwnProperty.call(tools[0], 'description')).toBe(false);
    });
  });

  describe('close', () => {
    it('calls SDK close and clears internal state', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const client = new ToolClient(makeRegistered());
      // Establish a connection first
      await client.callTool('ping', {});
      await client.close();
      expect(mocks.mockClose).toHaveBeenCalledTimes(1);
      // After close a new callTool must reconnect (connect called twice total)
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      await client.callTool('ping', {});
      expect(mocks.mockConnect).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when not connected', async () => {
      const client = new ToolClient(makeRegistered());
      await expect(client.close()).resolves.toBeUndefined();
      expect(mocks.mockClose).not.toHaveBeenCalled();
    });

    it('does not throw if SDK close rejects', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      mocks.mockClose.mockRejectedValue(new Error('close failed'));
      const client = new ToolClient(makeRegistered());
      await client.callTool('ping', {});
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('resolveCommand (tested via ensureConnected)', () => {
    it('uses installCommand when present', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const registered = makeRegistered({
        tool: {
          id: 'tool-1',
          name: 'test-tool',
          version: '1.0.0',
          description: 'desc',
          source: 'local',
          capabilities: [],
          tags: [],
          installCommand: 'node server.js',
        },
      });
      const client = new ToolClient(registered);
      await client.callTool('t', {});
      const ctorArg = MockStdioTransport.mock.calls[0]![0] as Record<string, unknown>;
      expect(ctorArg['command']).toBe('node');
      expect(ctorArg['args']).toContain('server.js');
    });

    it('falls back to entryPoint (node <path>) when no installCommand', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const registered = makeRegistered({
        tool: {
          id: 'tool-1',
          name: 'test-tool',
          version: '1.0.0',
          description: 'desc',
          source: 'local',
          capabilities: [],
          tags: [],
          // no installCommand
          entryPoint: '/opt/tools/index.js',
        },
      });
      const client = new ToolClient(registered);
      await client.callTool('t', {});
      const ctorArg = MockStdioTransport.mock.calls[0]![0] as Record<string, unknown>;
      expect(ctorArg['command']).toBe('node');
      expect((ctorArg['args'] as string[])[0]).toBe('/opt/tools/index.js');
    });

    it('falls back to metadata.command when no installCommand or entryPoint', async () => {
      mocks.mockCallTool.mockResolvedValue({ content: [] });
      const registered = makeRegistered({
        tool: {
          id: 'tool-1',
          name: 'test-tool',
          version: '1.0.0',
          description: 'desc',
          source: 'local',
          capabilities: [],
          tags: [],
          metadata: { command: 'python main.py' },
        },
      });
      const client = new ToolClient(registered);
      await client.callTool('t', {});
      const ctorArg = MockStdioTransport.mock.calls[0]![0] as Record<string, unknown>;
      expect(ctorArg['command']).toBe('python');
      expect((ctorArg['args'] as string[])[0]).toBe('main.py');
    });

    it('throws when no command can be resolved', async () => {
      const registered = makeRegistered({
        tool: {
          id: 'tool-1',
          name: 'test-tool',
          version: '1.0.0',
          description: 'desc',
          source: 'local',
          capabilities: [],
          tags: [],
          // no installCommand, no entryPoint, no metadata.command
        },
      });
      const client = new ToolClient(registered);
      await expect(client.callTool('t', {})).rejects.toThrow(
        'Cannot resolve start command for MCP client: tool-1',
      );
    });
  });
});

// ── ToolClientPool ────────────────────────────────────────────────────────────

describe('ToolClientPool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupClientMocks();
  });

  it('acquire() creates a new ToolClient and caches it', () => {
    const pool = new ToolClientPool();
    const reg = makeRegistered();
    const client = pool.acquire(reg);
    expect(client).toBeInstanceOf(ToolClient);
    expect(client.toolId).toBe('tool-1');
  });

  it('acquire() returns the same instance on subsequent calls', () => {
    const pool = new ToolClientPool();
    const reg = makeRegistered();
    const first = pool.acquire(reg);
    const second = pool.acquire(reg);
    expect(first).toBe(second);
  });

  it('get() returns undefined for an unknown toolId', () => {
    const pool = new ToolClientPool();
    expect(pool.get('does-not-exist')).toBeUndefined();
  });

  it('get() returns the cached ToolClient after acquire()', () => {
    const pool = new ToolClientPool();
    const reg = makeRegistered();
    const client = pool.acquire(reg);
    expect(pool.get('tool-1')).toBe(client);
  });

  it('release() closes the client and removes it from the pool', async () => {
    // Arrange: give the client a connected SDK instance so close() works
    const { mockCallTool, mockClose } = setupClientMocks();
    mockCallTool.mockResolvedValue({ content: [] });

    const pool = new ToolClientPool();
    const reg = makeRegistered();
    const client = pool.acquire(reg);

    // Connect by calling a tool
    await client.callTool('ping', {});

    await pool.release('tool-1');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(pool.get('tool-1')).toBeUndefined();
  });

  it('release() is a no-op for an unknown toolId', async () => {
    const pool = new ToolClientPool();
    await expect(pool.release('ghost')).resolves.toBeUndefined();
  });

  it('closeAll() closes every client in the pool', async () => {
    const { mockCallTool, mockClose } = setupClientMocks();
    mockCallTool.mockResolvedValue({ content: [] });

    const pool = new ToolClientPool();

    const reg1 = makeRegistered({ tool: { ...makeRegistered().tool, id: 'tool-1' } });
    const reg2 = makeRegistered({ tool: { ...makeRegistered().tool, id: 'tool-2' } });
    const c1 = pool.acquire(reg1);
    const c2 = pool.acquire(reg2);

    // Connect both
    await c1.callTool('ping', {});
    await c2.callTool('ping', {});

    await pool.closeAll();

    expect(mockClose).toHaveBeenCalledTimes(2);
    expect(pool.get('tool-1')).toBeUndefined();
    expect(pool.get('tool-2')).toBeUndefined();
  });
});
