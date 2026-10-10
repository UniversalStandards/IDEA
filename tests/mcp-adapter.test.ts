/**
 * tests/mcp-adapter.test.ts
 * Unit tests for src/adapters/mcp/index.ts and src/adapters/mcp/define-tool.ts.
 *
 * The MCP SDK's McpServer is replaced with a recorder so each registered tool
 * handler can be invoked directly, without a transport.
 */

const mockRegisterTool = jest.fn();
const mockConnect = jest.fn();
const mockServerCtor = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation((...args: unknown[]) => {
    mockServerCtor(...args);
    return { registerTool: mockRegisterTool, connect: mockConnect };
  }),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), getSnapshot: jest.fn() },
}));

jest.mock('../src/discovery/registry-manager', () => ({
  registryManager: { search: jest.fn(), getById: jest.fn() },
}));

jest.mock('../src/provisioning/installer', () => ({
  installer: { install: jest.fn() },
}));

jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: { list: jest.fn(), get: jest.fn() },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: {
    evaluate: jest.fn(),
    listPolicies: jest.fn(),
    addPolicy: jest.fn(),
    removePolicy: jest.fn(),
  },
}));

jest.mock('../src/routing/provider-router', () => ({
  providerRouter: { listProviders: jest.fn(), route: jest.fn() },
}));

jest.mock('../src/normalization/request-normalizer', () => ({
  requestNormalizer: { normalize: jest.fn() },
}));

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPAdapter } from '../src/adapters/mcp/index';
import { defineTool } from '../src/adapters/mcp/define-tool';
import { getServiceVersion } from '../src/version';
import { metrics } from '../src/observability/metrics';
import { registryManager } from '../src/discovery/registry-manager';
import { installer } from '../src/provisioning/installer';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import { policyEngine } from '../src/policy/policy-engine';
import { providerRouter } from '../src/routing/provider-router';
import { requestNormalizer } from '../src/normalization/request-normalizer';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface RegisteredConfig {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Look up the handler the adapter registered under `name`. */
function handlerFor(name: string): Handler {
  const call = mockRegisterTool.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`tool not registered: ${name}`);
  return call[2] as Handler;
}

/** Parse the JSON text payload of a successful tool result. */
function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Read the plain text of any tool result (used for error messages). */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('defineTool()', () => {
  it('forwards name, description and input schema to registerTool', () => {
    const registerTool = jest.fn();
    const server = { registerTool } as unknown as McpServer;
    const shape = { query: z.string() };

    defineTool(server, 'my_tool', 'Does a thing', shape, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config] = registerTool.mock.calls[0] as [string, RegisteredConfig, Handler];
    expect(name).toBe('my_tool');
    expect(config).toEqual({ description: 'Does a thing', inputSchema: shape });
  });

  it('passes the validated args to the handler and returns its result unchanged', async () => {
    const registerTool = jest.fn();
    const server = { registerTool } as unknown as McpServer;
    const handler = jest.fn(async (args: { query: string }) => ({
      content: [{ type: 'text' as const, text: `got ${args.query}` }],
    }));

    defineTool(server, 'echo', 'Echo', { query: z.string() }, handler);
    const registered = registerTool.mock.calls[0]?.[2] as Handler;
    const result = await registered({ query: 'abc' });

    expect(handler).toHaveBeenCalledWith({ query: 'abc' });
    expect(textOf(result)).toBe('got abc');
  });

  it('propagates a handler rejection to the caller', async () => {
    const registerTool = jest.fn();
    const server = { registerTool } as unknown as McpServer;

    defineTool(server, 'boom', 'Boom', {}, async () => {
      throw new Error('handler failed');
    });
    const registered = registerTool.mock.calls[0]?.[2] as Handler;

    await expect(registered({})).rejects.toThrow('handler failed');
  });
});

describe('MCPAdapter construction', () => {
  it('creates the server under the product name', () => {
    new MCPAdapter();
    expect(mockServerCtor).toHaveBeenCalledWith({
      name: 'Universal Standard MCP Server',
      version: getServiceVersion(),
    });
    // Must track package.json rather than a hardcoded literal.
    expect(getServiceVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers exactly the seven hub tools, each with a description', () => {
    new MCPAdapter();

    const names = mockRegisterTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual([
      'discover_capabilities',
      'install_tool',
      'list_installed_tools',
      'execute_capability',
      'get_hub_status',
      'manage_policy',
      'route_to_provider',
    ]);
    for (const call of mockRegisterTool.mock.calls) {
      const config = call[1] as RegisteredConfig;
      expect(config.description.length).toBeGreaterThan(0);
    }
  });

  it('exposes the underlying server and forwards connect() to it', async () => {
    const adapter = new MCPAdapter();
    const transport = {} as Parameters<MCPAdapter['connect']>[0];

    await adapter.connect(transport);

    expect(mockConnect).toHaveBeenCalledWith(transport);
    expect(adapter.getServer()).toBeDefined();
  });
});

describe('tool: discover_capabilities', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('searches with a default limit of 20 and returns count and tools', async () => {
    jest.mocked(registryManager.search).mockResolvedValue([{ id: 't1' }, { id: 't2' }] as never);

    const result = await handlerFor('discover_capabilities')({ query: 'db' });

    expect(registryManager.search).toHaveBeenCalledWith({ query: 'db', limit: 20 });
    expect(payload(result)).toMatchObject({ count: 2 });
    expect(metrics.increment).toHaveBeenCalledWith('mcp_tool_calls_total', { tool: 'discover_capabilities' });
  });

  it('honours an explicit limit', async () => {
    jest.mocked(registryManager.search).mockResolvedValue([]);

    await handlerFor('discover_capabilities')({ query: 'db', limit: 5 });

    expect(registryManager.search).toHaveBeenCalledWith({ query: 'db', limit: 5 });
  });

  it('returns an isError result instead of throwing when the search fails', async () => {
    jest.mocked(registryManager.search).mockRejectedValue(new Error('registry down'));

    const result = await handlerFor('discover_capabilities')({ query: 'db' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: registry down');
  });
});

describe('tool: install_tool', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('reports an error when the tool is unknown', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue(null);

    const result = await handlerFor('install_tool')({ toolId: 'nope' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool not found: nope');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('refuses to install when policy denies it', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue({ id: 'tool-a' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({
      allowed: false,
      reasons: ['untrusted source'],
    } as never);

    const result = await handlerFor('install_tool')({ toolId: 'tool-a' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Policy denied installation: untrusted source');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('evaluates policy as the mcp-client actor for the install action', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue({ id: 'tool-a' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, reasons: [] } as never);
    jest.mocked(installer.install).mockResolvedValue({
      success: true,
      tool: { id: 'tool-a' },
      installedAt: new Date('2026-01-01T00:00:00.000Z'),
      path: '/opt/tool-a',
    } as never);

    await handlerFor('install_tool')({ toolId: 'tool-a' });

    expect(policyEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'tool-a', actor: 'mcp-client', action: 'install' }),
    );
  });

  it('installs an allowed tool and reports the result', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue({ id: 'tool-a' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, reasons: [] } as never);
    jest.mocked(installer.install).mockResolvedValue({
      success: true,
      tool: { id: 'tool-a' },
      installedAt: new Date('2026-01-01T00:00:00.000Z'),
      path: '/opt/tool-a',
    } as never);

    const result = await handlerFor('install_tool')({ toolId: 'tool-a' });

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      success: true,
      toolId: 'tool-a',
      path: '/opt/tool-a',
    });
  });

  it('returns an isError result when the installer throws', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue({ id: 'tool-a' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, reasons: [] } as never);
    jest.mocked(installer.install).mockRejectedValue(new Error('disk full'));

    const result = await handlerFor('install_tool')({ toolId: 'tool-a' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: disk full');
  });
});

describe('tool: list_installed_tools', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('maps registered runtimes to a summary list', async () => {
    const registeredAt = new Date('2026-01-01T00:00:00.000Z');
    jest.mocked(runtimeRegistrar.list).mockReturnValue([
      {
        tool: { id: 'a', name: 'Tool A', version: '1.0.0', capabilities: ['x'] },
        status: 'running',
        registeredAt,
      },
    ] as never);

    const result = await handlerFor('list_installed_tools')({});

    expect(payload(result)).toEqual({
      count: 1,
      tools: [
        {
          id: 'a',
          name: 'Tool A',
          version: '1.0.0',
          status: 'running',
          registeredAt: registeredAt.toISOString(),
          capabilities: ['x'],
        },
      ],
    });
  });

  it('returns an isError result when the registrar throws', async () => {
    jest.mocked(runtimeRegistrar.list).mockImplementation(() => {
      throw new Error('registrar offline');
    });

    const result = await handlerFor('list_installed_tools')({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: registrar offline');
  });
});

describe('tool: execute_capability', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('requires the tool to be registered first', async () => {
    jest.mocked(runtimeRegistrar.get).mockReturnValue(undefined);

    const result = await handlerFor('execute_capability')({ toolId: 'tool-a', action: 'run' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool not registered: tool-a. Use install_tool first.');
  });

  it('refuses execution when policy denies the action', async () => {
    jest.mocked(runtimeRegistrar.get).mockReturnValue({ status: 'running' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({
      allowed: false,
      reasons: ['needs approval'],
    } as never);

    const result = await handlerFor('execute_capability')({ toolId: 'tool-a', action: 'run' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Policy denied execution: needs approval');
    expect(requestNormalizer.normalize).not.toHaveBeenCalled();
  });

  it('normalizes the request as an mcp call, defaulting params to an empty object', async () => {
    jest.mocked(runtimeRegistrar.get).mockReturnValue({ status: 'running' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, reasons: [] } as never);
    jest.mocked(requestNormalizer.normalize).mockReturnValue({ id: 'req-9' } as never);

    const result = await handlerFor('execute_capability')({ toolId: 'tool-a', action: 'run' });

    expect(requestNormalizer.normalize).toHaveBeenCalledWith(
      { method: 'run', params: {}, toolId: 'tool-a' },
      'mcp',
    );
    expect(payload(result)).toEqual({
      executed: true,
      toolId: 'tool-a',
      action: 'run',
      requestId: 'req-9',
      status: 'running',
    });
  });

  it('forwards caller-supplied params to the normalizer', async () => {
    jest.mocked(runtimeRegistrar.get).mockReturnValue({ status: 'running' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, reasons: [] } as never);
    jest.mocked(requestNormalizer.normalize).mockReturnValue({ id: 'req-10' } as never);

    await handlerFor('execute_capability')({ toolId: 'tool-a', action: 'run', params: { n: 1 } });

    expect(requestNormalizer.normalize).toHaveBeenCalledWith(
      { method: 'run', params: { n: 1 }, toolId: 'tool-a' },
      'mcp',
    );
  });
});

describe('tool: get_hub_status', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('summarizes installed and running tools, providers and metrics', async () => {
    jest.mocked(metrics.getSnapshot).mockReturnValue({ counters: [] } as never);
    jest.mocked(runtimeRegistrar.list).mockReturnValue([
      { status: 'running' },
      { status: 'registered' },
      { status: 'running' },
    ] as never);
    jest.mocked(providerRouter.listProviders).mockReturnValue([
      { id: 'p1', name: 'Provider 1', capabilities: ['chat'] },
    ] as never);

    const body = payload(await handlerFor('get_hub_status')({}));

    expect(body).toMatchObject({
      installedTools: 3,
      runningTools: 2,
      providers: [{ id: 'p1', name: 'Provider 1', capabilities: ['chat'] }],
      metrics: { counters: [] },
    });
    expect(typeof body['timestamp']).toBe('string');
  });
});

describe('tool: manage_policy', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('lists policies', async () => {
    jest.mocked(policyEngine.listPolicies).mockReturnValue([{ id: 'p1' }, { id: 'p2' }] as never);

    const body = payload(await handlerFor('manage_policy')({ action: 'list' }));

    expect(body).toMatchObject({ count: 2 });
  });

  it('rejects add without a policy object', async () => {
    const result = await handlerFor('manage_policy')({ action: 'add' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('policy object required for add action');
    expect(policyEngine.addPolicy).not.toHaveBeenCalled();
  });

  it('adds a policy', async () => {
    const policy = { id: 'p9', effect: 'deny' };

    const body = payload(await handlerFor('manage_policy')({ action: 'add', policy }));

    expect(policyEngine.addPolicy).toHaveBeenCalledWith(policy);
    expect(body).toEqual({ added: true });
  });

  it('rejects remove without a policy id', async () => {
    const result = await handlerFor('manage_policy')({ action: 'remove', policy: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('policy.id required for remove action');
    expect(policyEngine.removePolicy).not.toHaveBeenCalled();
  });

  it('removes a policy by id', async () => {
    const body = payload(
      await handlerFor('manage_policy')({ action: 'remove', policy: { id: 'p9' } }),
    );

    expect(policyEngine.removePolicy).toHaveBeenCalledWith('p9');
    expect(body).toEqual({ removed: true, id: 'p9' });
  });
});

describe('tool: route_to_provider', () => {
  beforeEach(() => {
    new MCPAdapter();
  });

  it('reports an error when no provider supports the capability', async () => {
    jest.mocked(providerRouter.route).mockReturnValue(null);

    const result = await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('No provider available for capability: chat');
  });

  it('omits preferredProvider entirely when the caller does not specify one', async () => {
    jest.mocked(providerRouter.route).mockReturnValue(null);

    await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi' });

    const arg = jest.mocked(providerRouter.route).mock.calls[0]?.[0];
    expect(arg).toEqual({ capability: 'chat', fallback: true });
    expect(arg).not.toHaveProperty('preferredProvider');
  });

  it('passes the preferred provider through when specified', async () => {
    jest.mocked(providerRouter.route).mockReturnValue(null);

    await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi', provider: 'openai' });

    expect(providerRouter.route).toHaveBeenCalledWith({
      capability: 'chat',
      preferredProvider: 'openai',
      fallback: true,
    });
  });

  it('returns the routed provider without leaking its API key', async () => {
    jest.mocked(providerRouter.route).mockReturnValue({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-secret',
      models: ['gpt-4o'],
      maxTokens: 128000,
      capabilities: ['chat'],
    } as never);

    const result = await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi' });
    const body = payload(result);

    expect(body['provider']).toEqual({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      models: ['gpt-4o'],
      maxTokens: 128000,
    });
    expect(textOf(result)).not.toContain('sk-secret');
  });
});
