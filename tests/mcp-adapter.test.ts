/**
 * tests/mcp-adapter.test.ts
 * Unit tests for src/adapters/mcp/index.ts and src/adapters/mcp/define-tool.ts.
 *
 * The MCP SDK's McpServer is replaced with a recorder so each registered tool
 * handler can be invoked directly, without a transport. Approval and the
 * downstream connection manager are injected.
 */

const mockRegisterTool = jest.fn();
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockServerCtor = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation((...args: unknown[]) => {
    mockServerCtor(...args);
    return {
      registerTool: mockRegisterTool,
      connect: mockConnect,
      close: mockClose,
      server: { getClientCapabilities: () => undefined },
    };
  }),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), getSnapshot: jest.fn(), histogram: jest.fn(), gauge: jest.fn() },
}));

jest.mock('../src/config', () => ({
  config: { AUTO_APPROVE_TOOLS: '', APPROVAL_ELICITATION_TIMEOUT_MS: 1000, MCP_TRANSPORT: 'stdio' },
  getAutoApprovedTools: () => new Set<string>(),
}));

jest.mock('../src/discovery/registry-manager', () => ({
  registryManager: { search: jest.fn(), getById: jest.fn() },
}));

jest.mock('../src/provisioning/installer', () => ({
  installer: {
    install: jest.fn(),
    assess: jest.fn(),
    isInstalled: jest.fn(),
    getInstallResult: jest.fn(),
    uninstall: jest.fn(),
  },
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

const mockObtainApproval = jest.fn();
jest.mock('../src/adapters/mcp/approval', () => ({
  obtainApproval: (...args: unknown[]) => mockObtainApproval(...args),
  pendingApprovalMessage: (o: { approvalId: string }, tool: string) =>
    JSON.stringify({ status: 'approval_required', approvalId: o.approvalId, retry: { tool } }),
}));

jest.mock('../src/adapters/mcp/downstream', () => {
  class DownstreamError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { DownstreamError, getDownstreamClients: jest.fn() };
});

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPAdapter } from '../src/adapters/mcp/index';
import { defineTool } from '../src/adapters/mcp/define-tool';
import { DownstreamError, getDownstreamClients } from '../src/adapters/mcp/downstream';
import { getServiceVersion } from '../src/version';
import { metrics } from '../src/observability/metrics';
import { registryManager } from '../src/discovery/registry-manager';
import { installer } from '../src/provisioning/installer';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import { policyEngine } from '../src/policy/policy-engine';
import { providerRouter } from '../src/routing/provider-router';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface RegisteredConfig {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const downstream = {
  listTools: jest.fn(),
  describeTool: jest.fn(),
  callTool: jest.fn(),
  close: jest.fn(),
  isConnected: jest.fn(),
  connectedToolIds: jest.fn(),
};

const TOOL = {
  id: 'official:memory',
  name: 'memory',
  version: '0.6.2',
  description: 'Memory',
  source: 'official' as const,
  capabilities: [],
  tags: [],
  installCommand: 'npx -y @modelcontextprotocol/server-memory',
};

function handlerFor(name: string): Handler {
  const call = mockRegisterTool.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`tool not registered: ${name}`);
  return call[2] as Handler;
}

function configFor(name: string): RegisteredConfig {
  const call = mockRegisterTool.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`tool not registered: ${name}`);
  return call[1] as RegisteredConfig;
}

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getDownstreamClients).mockReturnValue(downstream as never);
  downstream.isConnected.mockReturnValue(false);
  downstream.connectedToolIds.mockReturnValue([]);
  mockObtainApproval.mockResolvedValue({ status: 'approved', via: 'elicitation', approvalId: 'a-1' });
});

describe('defineTool()', () => {
  it('forwards name, description and input schema to registerTool', () => {
    const registerTool = jest.fn();
    const server = { registerTool } as unknown as McpServer;
    const shape = { query: z.string() };

    defineTool(server, 'my_tool', 'Does a thing', shape, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const [name, config] = registerTool.mock.calls[0] as [string, RegisteredConfig, Handler];
    expect(name).toBe('my_tool');
    expect(config).toEqual({ description: 'Does a thing', inputSchema: shape });
  });

  it('forwards tool annotations when provided', () => {
    const registerTool = jest.fn();
    defineTool(
      { registerTool } as unknown as McpServer,
      't',
      'd',
      {},
      async () => ({ content: [] }),
      { readOnlyHint: true },
    );
    expect((registerTool.mock.calls[0] as [string, RegisteredConfig])[1].annotations).toEqual({ readOnlyHint: true });
  });

  it('passes the validated args to the handler and returns its result unchanged', async () => {
    const registerTool = jest.fn();
    const handler = jest.fn(async (args: { query: string }) => ({
      content: [{ type: 'text' as const, text: `got ${args.query}` }],
    }));

    defineTool({ registerTool } as unknown as McpServer, 'echo', 'Echo', { query: z.string() }, handler);
    const result = await (registerTool.mock.calls[0]?.[2] as Handler)({ query: 'abc' });

    expect(handler).toHaveBeenCalledWith({ query: 'abc' });
    expect(textOf(result)).toBe('got abc');
  });

  it('propagates a handler rejection to the caller', async () => {
    const registerTool = jest.fn();
    defineTool({ registerTool } as unknown as McpServer, 'boom', 'Boom', {}, async () => {
      throw new Error('handler failed');
    });
    await expect((registerTool.mock.calls[0]?.[2] as Handler)({})).rejects.toThrow('handler failed');
  });
});

describe('MCPAdapter construction', () => {
  it('creates the server under the product name with client instructions', () => {
    new MCPAdapter();
    expect(mockServerCtor).toHaveBeenCalledWith(
      { name: 'Universal Standard MCP Server', version: getServiceVersion() },
      { instructions: expect.stringContaining('discover_capabilities') },
    );
    expect(getServiceVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers the nine hub tools, each with a description and annotations', () => {
    new MCPAdapter();
    const names = mockRegisterTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual([
      'discover_capabilities',
      'install_tool',
      'uninstall_tool',
      'list_installed_tools',
      'list_capability_actions',
      'execute_capability',
      'get_hub_status',
      'manage_policy',
      'route_to_provider',
    ]);
    for (const call of mockRegisterTool.mock.calls) {
      const config = call[1] as RegisteredConfig;
      expect(config.description.length).toBeGreaterThan(0);
      expect(config.annotations).toBeDefined();
    }
    expect(configFor('list_installed_tools').annotations).toMatchObject({ readOnlyHint: true });
    expect(configFor('uninstall_tool').annotations).toMatchObject({ destructiveHint: true });
  });

  it('connects and closes through the underlying server', async () => {
    const adapter = new MCPAdapter();
    const transport = {} as never;
    await adapter.connect(transport);
    await adapter.close();
    expect(mockConnect).toHaveBeenCalledWith(transport);
    expect(mockClose).toHaveBeenCalled();
    expect(adapter.getServer()).toBeDefined();
  });

  it('uses an injected downstream manager instead of the shared one', async () => {
    const injected = { ...downstream, connectedToolIds: jest.fn().mockReturnValue(['x']) };
    new MCPAdapter({ downstream: injected as never });
    jest.mocked(runtimeRegistrar.list).mockReturnValue([]);
    jest.mocked(providerRouter.listProviders).mockReturnValue([]);
    const body = payload(await handlerFor('get_hub_status')({}));
    expect(body['connectedTools']).toEqual(['x']);
    expect(getDownstreamClients).not.toHaveBeenCalled();
  });
});

describe('tool: discover_capabilities', () => {
  beforeEach(() => new MCPAdapter());

  it('searches with a default limit of 20 and flags installed tools', async () => {
    jest.mocked(registryManager.search).mockResolvedValue([TOOL] as never);
    jest.mocked(installer.isInstalled).mockReturnValue(true);

    const body = payload(await handlerFor('discover_capabilities')({ query: 'memory' }));

    expect(registryManager.search).toHaveBeenCalledWith({ query: 'memory', limit: 20 });
    expect(body).toMatchObject({ count: 1, tools: [{ id: 'official:memory', installed: true }] });
    expect(metrics.increment).toHaveBeenCalledWith('mcp_tool_calls_total', { tool: 'discover_capabilities' });
  });

  it('returns an isError result when the search fails', async () => {
    jest.mocked(registryManager.search).mockRejectedValue(new Error('registry down'));
    const result = await handlerFor('discover_capabilities')({ query: 'x', limit: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: registry down');
  });
});

describe('tool: install_tool', () => {
  beforeEach(() => {
    new MCPAdapter();
    jest.mocked(registryManager.getById).mockResolvedValue(TOOL as never);
    jest.mocked(installer.isInstalled).mockReturnValue(false);
    jest.mocked(installer.assess).mockReturnValue({
      requiresApproval: true,
      reasons: [],
      trustScore: 80,
      trustLevel: 'high',
      minimumTrust: 50,
    });
    jest.mocked(installer.install).mockResolvedValue({
      success: true,
      tool: TOOL,
      installedAt: new Date('2026-01-01T00:00:00Z'),
      path: '/data/.mcp/installed/memory',
    } as never);
    downstream.listTools.mockResolvedValue([{ name: 'create_entities', inputSchema: {} }]);
  });

  it('reports an unknown tool', async () => {
    jest.mocked(registryManager.getById).mockResolvedValue(null);
    const result = await handlerFor('install_tool')({ toolId: 'nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Tool not found: nope');
  });

  it('is idempotent for an installed tool', async () => {
    jest.mocked(installer.isInstalled).mockReturnValue(true);
    jest.mocked(installer.getInstallResult).mockReturnValue({ path: '/p', installedAt: new Date(0) } as never);
    const body = payload(await handlerFor('install_tool')({ toolId: TOOL.id }));
    expect(body).toMatchObject({ success: true, alreadyInstalled: true, path: '/p' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('refuses when governance denies the install outright', async () => {
    jest.mocked(installer.assess).mockReturnValue({
      denied: 'Policy denied installation: nope',
      requiresApproval: false,
      reasons: [],
      trustScore: 0,
      trustLevel: 'low',
      minimumTrust: 50,
    });
    const result = await handlerFor('install_tool')({ toolId: TOOL.id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Policy denied installation: nope');
    expect(mockObtainApproval).not.toHaveBeenCalled();
  });

  it('obtains approval, installs pre-approved with args, and verifies the server starts', async () => {
    const body = payload(
      await handlerFor('install_tool')({ toolId: TOOL.id, args: ['/data/ws'], approvalId: undefined }),
    );

    expect(installer.assess).toHaveBeenCalledWith(TOOL, 'mcp-client');
    expect(mockObtainApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: TOOL.id, action: 'install', actor: 'mcp-client', payload: { args: ['/data/ws'] } }),
    );
    expect(installer.install).toHaveBeenCalledWith(TOOL, {
      preApproved: true,
      actor: 'mcp-client',
      args: ['/data/ws'],
    });
    expect(body).toMatchObject({
      success: true,
      toolId: TOOL.id,
      approvedVia: 'elicitation',
      actions: ['create_entities'],
    });
  });

  it('skips approval when governance does not require it', async () => {
    jest.mocked(installer.assess).mockReturnValue({
      requiresApproval: false,
      reasons: [],
      trustScore: 90,
      trustLevel: 'high',
      minimumTrust: 50,
    });
    const body = payload(await handlerFor('install_tool')({ toolId: TOOL.id }));
    expect(mockObtainApproval).not.toHaveBeenCalled();
    expect(installer.install).toHaveBeenCalledWith(TOOL, { preApproved: false, actor: 'mcp-client' });
    expect(body).not.toHaveProperty('approvedVia');
  });

  it('returns approval_required when approval is pending', async () => {
    mockObtainApproval.mockResolvedValue({ status: 'pending', approvalId: 'p-1' });
    const result = await handlerFor('install_tool')({ toolId: TOOL.id });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ status: 'approval_required', approvalId: 'p-1', retry: { tool: 'install_tool' } });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('returns the rejection reason when approval is rejected', async () => {
    mockObtainApproval.mockResolvedValue({ status: 'rejected', reason: 'user said no' });
    const result = await handlerFor('install_tool')({ toolId: TOOL.id });
    expect(textOf(result)).toBe('Approval rejected: user said no');
  });

  it('reports an installer failure', async () => {
    jest.mocked(installer.install).mockResolvedValue({ success: false, tool: TOOL, installedAt: new Date(), error: 'npm 404' } as never);
    const result = await handlerFor('install_tool')({ toolId: TOOL.id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Installation failed: npm 404');
  });

  it('reports a startup warning when the installed server does not start', async () => {
    downstream.listTools.mockRejectedValue(new Error('exited with code 1'));
    const body = payload(await handlerFor('install_tool')({ toolId: TOOL.id }));
    expect(body['success']).toBe(true);
    expect(String(body['startupWarning'])).toContain('exited with code 1');
    expect(body).not.toHaveProperty('actions');
  });

  it('returns an isError result when the installer throws', async () => {
    jest.mocked(installer.install).mockRejectedValue(new Error('disk full'));
    const result = await handlerFor('install_tool')({ toolId: TOOL.id });
    expect(textOf(result)).toBe('Error: disk full');
  });
});

describe('tool: uninstall_tool', () => {
  beforeEach(() => {
    new MCPAdapter();
    jest.mocked(installer.isInstalled).mockReturnValue(true);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
  });

  it('rejects a tool that is not installed', async () => {
    jest.mocked(installer.isInstalled).mockReturnValue(false);
    const result = await handlerFor('uninstall_tool')({ toolId: 'x' });
    expect(textOf(result)).toBe('Tool not installed: x');
  });

  it('refuses when policy denies the uninstall', async () => {
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: false, requiresApproval: false, reasons: ['no'] });
    const result = await handlerFor('uninstall_tool')({ toolId: TOOL.id });
    expect(textOf(result)).toBe('Policy denied uninstall: no');
  });

  it('closes the downstream connection and uninstalls after approval', async () => {
    const body = payload(await handlerFor('uninstall_tool')({ toolId: TOOL.id }));
    expect(mockObtainApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'uninstall' }));
    expect(downstream.close).toHaveBeenCalledWith(TOOL.id);
    expect(installer.uninstall).toHaveBeenCalledWith(TOOL.id, 'mcp-client');
    expect(body).toEqual({ success: true, uninstalled: TOOL.id });
  });

  it('does not uninstall while approval is pending', async () => {
    mockObtainApproval.mockResolvedValue({ status: 'pending', approvalId: 'p-2' });
    const result = await handlerFor('uninstall_tool')({ toolId: TOOL.id });
    expect(result.isError).toBe(true);
    expect(installer.uninstall).not.toHaveBeenCalled();
  });

  it('skips approval when policy allows the action', async () => {
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] });
    await handlerFor('uninstall_tool')({ toolId: TOOL.id });
    expect(mockObtainApproval).not.toHaveBeenCalled();
    expect(installer.uninstall).toHaveBeenCalled();
  });

  it('returns an isError result when uninstall throws', async () => {
    jest.mocked(installer.uninstall).mockRejectedValue(new Error('busy'));
    expect(textOf(await handlerFor('uninstall_tool')({ toolId: TOOL.id }))).toBe('Error: busy');
  });
});

describe('tool: list_installed_tools', () => {
  beforeEach(() => new MCPAdapter());

  it('maps registered runtimes, including connection status and launch args', async () => {
    jest.mocked(runtimeRegistrar.list).mockReturnValue([
      {
        tool: { ...TOOL, capabilities: ['store'] },
        status: 'registered',
        registeredAt: new Date('2026-01-01T00:00:00Z'),
        config: { args: ['--x'] },
      },
    ] as never);
    downstream.isConnected.mockReturnValue(true);

    const body = payload(await handlerFor('list_installed_tools')({}));

    expect(body).toMatchObject({
      count: 1,
      tools: [{ id: TOOL.id, connected: true, args: ['--x'], capabilities: ['store'], status: 'registered' }],
    });
  });

  it('returns an isError result when listing throws', async () => {
    jest.mocked(runtimeRegistrar.list).mockImplementation(() => {
      throw new Error('broken');
    });
    expect(textOf(await handlerFor('list_installed_tools')({}))).toBe('Error: broken');
  });
});

describe('tool: list_capability_actions', () => {
  beforeEach(() => new MCPAdapter());

  it('returns the downstream actions with schemas and annotations', async () => {
    downstream.listTools.mockResolvedValue([
      { name: 'read_graph', description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'bare', inputSchema: {} },
    ]);
    const body = payload(await handlerFor('list_capability_actions')({ toolId: TOOL.id }));
    expect(body).toEqual({
      toolId: TOOL.id,
      count: 2,
      actions: [
        { name: 'read_graph', description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'bare', inputSchema: {} },
      ],
    });
  });

  it('reports downstream errors as tool errors', async () => {
    downstream.listTools.mockRejectedValue(new DownstreamError('NOT_REGISTERED', 'Tool not registered'));
    const result = await handlerFor('list_capability_actions')({ toolId: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: Tool not registered');
  });

  it('reports unexpected errors as tool errors', async () => {
    downstream.listTools.mockRejectedValue(new Error('boom'));
    expect(textOf(await handlerFor('list_capability_actions')({ toolId: 'x' }))).toBe('Error: boom');
  });
});

describe('tool: execute_capability', () => {
  const RESULT: CallToolResult = { content: [{ type: 'text', text: 'downstream says hi' }] };

  beforeEach(() => {
    new MCPAdapter();
    jest.mocked(runtimeRegistrar.get).mockReturnValue({ status: 'registered' } as never);
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] });
    downstream.describeTool.mockResolvedValue({ name: 'read_graph', inputSchema: {} });
    downstream.callTool.mockResolvedValue(RESULT);
  });

  it('rejects an unregistered tool', async () => {
    jest.mocked(runtimeRegistrar.get).mockReturnValue(undefined);
    const result = await handlerFor('execute_capability')({ toolId: 'x', action: 'a' });
    expect(textOf(result)).toBe('Tool not registered: x. Use install_tool first.');
  });

  it('refuses when policy denies execution', async () => {
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: false, requiresApproval: false, reasons: ['deny'] });
    const result = await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'read_graph' });
    expect(textOf(result)).toBe('Policy denied execution: deny');
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    downstream.describeTool.mockResolvedValue(undefined);
    const result = await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'nope' });
    expect(textOf(result)).toContain("Unknown action 'nope'");
  });

  it('calls the downstream tool and returns its result unchanged, defaulting params', async () => {
    const result = await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'read_graph' });
    expect(policyEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: TOOL.id, action: 'read_graph', actor: 'mcp-client' }),
    );
    expect(downstream.callTool).toHaveBeenCalledWith(TOOL.id, 'read_graph', {});
    expect(result).toBe(RESULT);
    expect(mockObtainApproval).not.toHaveBeenCalled();
  });

  it('requires approval for policy high-risk actions', async () => {
    jest.mocked(policyEngine.evaluate).mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
    await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'read_graph', params: { a: 1 }, approvalId: 'x' });
    expect(mockObtainApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'read_graph',
        approvalId: 'x',
        payload: { params: { a: 1 } },
        metadata: { params: { a: 1 } },
      }),
    );
    expect(downstream.callTool).toHaveBeenCalledWith(TOOL.id, 'read_graph', { a: 1 });
  });

  it('requires approval for actions the server declares destructive', async () => {
    downstream.describeTool.mockResolvedValue({ name: 'wipe', inputSchema: {}, annotations: { destructiveHint: true } });
    mockObtainApproval.mockResolvedValue({ status: 'pending', approvalId: 'p-3' });
    const result = await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'wipe' });
    expect(result.isError).toBe(true);
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it('does not treat read-only destructive hints as destructive', async () => {
    downstream.describeTool.mockResolvedValue({
      name: 'peek',
      inputSchema: {},
      annotations: { destructiveHint: true, readOnlyHint: true },
    });
    await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'peek' });
    expect(mockObtainApproval).not.toHaveBeenCalled();
  });

  it('reports downstream failures as tool errors', async () => {
    downstream.callTool.mockRejectedValue(new DownstreamError('RUNTIME_MISSING', "Runtime 'uvx' is not available"));
    const result = await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'read_graph' });
    expect(textOf(result)).toBe("Error: Runtime 'uvx' is not available");
  });

  it('reports unexpected errors as tool errors', async () => {
    downstream.callTool.mockRejectedValue(new Error('timeout'));
    expect(textOf(await handlerFor('execute_capability')({ toolId: TOOL.id, action: 'read_graph' }))).toBe(
      'Error: timeout',
    );
  });
});

describe('tool: get_hub_status', () => {
  beforeEach(() => new MCPAdapter());

  it('summarizes version, transport, tools, providers and metrics', async () => {
    jest.mocked(runtimeRegistrar.list).mockReturnValue([{ tool: TOOL }, { tool: TOOL }] as never);
    jest.mocked(providerRouter.listProviders).mockReturnValue([
      { id: 'p1', name: 'P1', capabilities: ['chat'], extra: 'dropped' },
    ] as never);
    jest.mocked(metrics.getSnapshot).mockReturnValue({ counters: {} } as never);
    downstream.connectedToolIds.mockReturnValue([TOOL.id]);

    const body = payload(await handlerFor('get_hub_status')({}));

    expect(body).toMatchObject({
      version: getServiceVersion(),
      transport: 'stdio',
      installedTools: 2,
      connectedTools: [TOOL.id],
      providers: [{ id: 'p1', name: 'P1', capabilities: ['chat'] }],
      metrics: { counters: {} },
    });
  });

  it('returns an isError result when status collection throws', async () => {
    jest.mocked(runtimeRegistrar.list).mockImplementation(() => {
      throw new Error('nope');
    });
    expect(textOf(await handlerFor('get_hub_status')({}))).toBe('Error: nope');
  });
});

describe('tool: manage_policy', () => {
  const POLICY = {
    id: 'allow-memory',
    name: 'Allow memory reads',
    rules: [{ match: { toolId: 'official:memory', action: 'read_*' }, action: 'allow', reason: 'safe' }],
  };

  beforeEach(() => {
    new MCPAdapter();
    jest.mocked(policyEngine.listPolicies).mockReturnValue([
      { id: 'default-deny-unknown', name: 'Deny', priority: 100, enabled: true, rules: [{ condition: () => true, action: 'deny', reason: 'r' }] },
    ] as never);
  });

  it('lists policies as JSON-safe summaries, flagging protected ones', async () => {
    const body = payload(await handlerFor('manage_policy')({ action: 'list' }));
    expect(body).toEqual({
      count: 1,
      policies: [
        { id: 'default-deny-unknown', name: 'Deny', priority: 100, enabled: true, protected: true, rules: [{ action: 'deny', reason: 'r' }] },
      ],
    });
    expect(mockObtainApproval).not.toHaveBeenCalled();
  });

  it('requires a policy object for add/remove', async () => {
    const result = await handlerFor('manage_policy')({ action: 'add' });
    expect(textOf(result)).toBe('policy object required for add action');
  });

  it('validates, approves, and adds a declarative policy', async () => {
    const body = payload(await handlerFor('manage_policy')({ action: 'add', policy: POLICY }));
    expect(mockObtainApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'hub:policy', action: 'modify_config', payload: { change: 'add', policy: POLICY } }),
    );
    const added = jest.mocked(policyEngine.addPolicy).mock.calls[0]?.[0];
    expect(added?.id).toBe('allow-memory');
    expect(added?.rules[0]?.condition({ toolId: 'official:memory', action: 'read_graph', actor: 'a', environment: 'e' })).toBe(true);
    expect(body).toEqual({ added: true, id: 'allow-memory' });
  });

  it('rejects an invalid policy without asking for approval', async () => {
    const result = await handlerFor('manage_policy')({ action: 'add', policy: { id: 'x' } });
    expect(result.isError).toBe(true);
    expect(mockObtainApproval).not.toHaveBeenCalled();
    expect(policyEngine.addPolicy).not.toHaveBeenCalled();
  });

  it('does not apply a change while approval is pending', async () => {
    mockObtainApproval.mockResolvedValue({ status: 'pending', approvalId: 'p-4' });
    const result = await handlerFor('manage_policy')({ action: 'add', policy: POLICY });
    expect(result.isError).toBe(true);
    expect(policyEngine.addPolicy).not.toHaveBeenCalled();
  });

  it('requires policy.id for remove', async () => {
    const result = await handlerFor('manage_policy')({ action: 'remove', policy: {} });
    expect(textOf(result)).toBe('policy.id required for remove action');
  });

  it('refuses to remove protected built-in policies', async () => {
    const result = await handlerFor('manage_policy')({ action: 'remove', policy: { id: 'default-high-risk-approval' } });
    expect(textOf(result)).toContain('protected built-in policy');
    expect(policyEngine.removePolicy).not.toHaveBeenCalled();
  });

  it('removes a custom policy after approval', async () => {
    jest.mocked(policyEngine.removePolicy).mockReturnValue(true);
    const body = payload(await handlerFor('manage_policy')({ action: 'remove', policy: { id: 'allow-memory' } }));
    expect(policyEngine.removePolicy).toHaveBeenCalledWith('allow-memory');
    expect(body).toEqual({ removed: true, id: 'allow-memory' });
  });
});

describe('tool: route_to_provider', () => {
  beforeEach(() => new MCPAdapter());

  it('reports when no provider can serve the capability', async () => {
    jest.mocked(providerRouter.route).mockReturnValue(null as never);
    const result = await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi' });
    expect(textOf(result)).toBe('No provider available for capability: chat');
  });

  it('returns the routing decision with the preferred provider forwarded', async () => {
    jest.mocked(providerRouter.route).mockReturnValue({
      id: 'p1',
      name: 'P1',
      baseUrl: 'https://p1',
      models: ['m'],
      maxTokens: 10,
    } as never);
    const body = payload(await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'hi', provider: 'p1' }));
    expect(providerRouter.route).toHaveBeenCalledWith({ capability: 'chat', preferredProvider: 'p1', fallback: true });
    expect(body).toMatchObject({ provider: { id: 'p1' }, capability: 'chat', prompt: 'hi' });
  });

  it('returns an isError result when routing throws', async () => {
    jest.mocked(providerRouter.route).mockImplementation(() => {
      throw new Error('router down');
    });
    expect(textOf(await handlerFor('route_to_provider')({ capability: 'chat', prompt: 'x' }))).toBe('Error: router down');
  });
});
