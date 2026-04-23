/**
 * tests/runtime-manager.test.ts
 * Unit tests for RuntimeManager — getCapabilities(), deregisterCapability(),
 * initialize(), shutdown(), getStatus(), handleRequest(), isInitialized().
 */

process.env['JWT_SECRET'] = 'test-jwt-secret-that-is-32-chars!!';
process.env['ENCRYPTION_KEY'] = 'test-enc-key-that-is-32-chars!!!';
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: {
    increment: jest.fn(),
    gauge: jest.fn(),
    histogram: jest.fn(),
    getSnapshot: jest.fn(() => ({ counters: [], gauges: [], histograms: [], timestamp: new Date() })),
  },
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn(), log: jest.fn() },
  auditLogger: { log: jest.fn() },
}));

jest.mock('../src/core/mcp-client', () => ({
  toolClientPool: {
    closeAll: jest.fn().mockResolvedValue(undefined),
    acquire: jest.fn().mockReturnValue({
      callTool: jest.fn().mockResolvedValue({ result: 'ok' }),
    }),
  },
}));

jest.mock('../src/discovery/registry-manager', () => ({
  registryManager: {
    listRegistries: jest.fn().mockReturnValue(['official']),
    search: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: {
    listPolicies: jest.fn().mockReturnValue([]),
    evaluate: jest.fn().mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] }),
  },
}));

jest.mock('../src/routing/provider-router', () => ({
  providerRouter: {
    listProviders: jest.fn().mockReturnValue([{ id: 'openai' }]),
  },
}));

jest.mock('../src/orchestration/workflow-engine', () => ({
  workflowEngine: {
    listWorkflows: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../src/routing/scheduler', () => ({
  scheduler: {
    getStats: jest.fn().mockReturnValue({ queued: 0, running: 0, completed: 0, failed: 0 }),
    schedule: jest.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
  },
}));

jest.mock('../src/orchestration/agent-router', () => ({
  agentRouter: {
    registerAgent: jest.fn(),
    listAgents: jest.fn().mockReturnValue([{ agentId: 'hub:default' }]),
  },
}));

jest.mock('../src/orchestration/execution-planner', () => ({
  executionPlanner: {
    plan: jest.fn().mockResolvedValue({
      id: 'plan-1',
      goal: 'test',
      steps: [],
      estimatedDuration: 0,
    }),
    execute: jest.fn().mockResolvedValue({
      planId: 'plan-1',
      success: true,
      steps: {},
      duration: 0,
    }),
  },
}));

jest.mock('../src/normalization/request-normalizer', () => ({
  requestNormalizer: {
    denormalize: jest.fn().mockReturnValue({ result: 'ok' }),
  },
}));

jest.mock('../src/routing/capability-selector', () => ({
  capabilitySelector: {
    select: jest.fn().mockReturnValue(null),
    recordOutcome: jest.fn(),
  },
}));

jest.mock('../src/provisioning/runtime-registrar', () => {
  const registryMap = new Map();
  return {
    runtimeRegistrar: {
      register: jest.fn((tool: import('../src/discovery/types').ToolMetadata, config: import('../src/provisioning/config-generator').ToolRuntimeConfig) => {
        const entry = { tool, config, registeredAt: new Date(), status: 'registered' as const };
        registryMap.set(tool.id, entry);
        return entry;
      }),
      unregister: jest.fn((id: string) => { registryMap.delete(id); }),
      get: jest.fn((id: string) => registryMap.get(id)),
      list: jest.fn(() => Array.from(registryMap.values())),
      stop: jest.fn(),
      isRunning: jest.fn().mockReturnValue(false),
    },
    _registryMap: registryMap,
  };
});

import { RuntimeManager } from '../src/core/runtime-manager';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import type { ToolMetadata } from '../src/discovery/types';
import type { ToolRuntimeConfig } from '../src/provisioning/config-generator';
import type { NormalizedRequest } from '../src/normalization/request-normalizer';

function makeTool(id: string): ToolMetadata {
  return {
    id,
    name: `Tool ${id}`,
    version: '1.0.0',
    description: `Description for ${id}`,
    source: 'local',
    capabilities: ['execute'],
    tags: ['test'],
  };
}

function makeConfig(): ToolRuntimeConfig {
  return {
    env: {},
    args: [],
    workingDir: '/tmp',
    timeout: 30_000,
  };
}

describe('RuntimeManager — getCapabilities()', () => {
  let manager: RuntimeManager;

  beforeEach(() => {
    manager = new RuntimeManager();
    // Clear any pre-existing registrations
    for (const rt of runtimeRegistrar.list()) {
      runtimeRegistrar.unregister(rt.tool.id);
    }
  });

  afterEach(() => {
    for (const rt of runtimeRegistrar.list()) {
      runtimeRegistrar.unregister(rt.tool.id);
    }
  });

  it('returns an empty array when no tools are registered', () => {
    const caps = manager.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBe(0);
  });

  it('returns one entry per registered tool', () => {
    runtimeRegistrar.register(makeTool('tool-a'), makeConfig());
    runtimeRegistrar.register(makeTool('tool-b'), makeConfig());
    const caps = manager.getCapabilities();
    expect(caps.length).toBe(2);
  });

  it('maps tool metadata correctly to capability shape', () => {
    runtimeRegistrar.register(makeTool('tool-xyz'), makeConfig());
    const caps = manager.getCapabilities();
    const cap = caps.find((c) => c.id === 'tool-xyz');
    expect(cap).toBeDefined();
    expect(cap?.name).toBe('Tool tool-xyz');
    expect(cap?.version).toBe('1.0.0');
    expect(cap?.source).toBe('local');
    expect(Array.isArray(cap?.capabilities)).toBe(true);
    expect(Array.isArray(cap?.tags)).toBe(true);
    expect(cap?.status).toBe('registered');
  });
});

describe('RuntimeManager — deregisterCapability()', () => {
  let manager: RuntimeManager;

  beforeEach(() => {
    manager = new RuntimeManager();
    for (const rt of runtimeRegistrar.list()) {
      runtimeRegistrar.unregister(rt.tool.id);
    }
  });

  afterEach(() => {
    for (const rt of runtimeRegistrar.list()) {
      runtimeRegistrar.unregister(rt.tool.id);
    }
  });

  it('returns false when the capability does not exist', () => {
    expect(manager.deregisterCapability('no-such-tool')).toBe(false);
  });

  it('returns true and removes the capability when it exists', () => {
    runtimeRegistrar.register(makeTool('remove-me'), makeConfig());
    expect(manager.getCapabilities().length).toBe(1);

    const result = manager.deregisterCapability('remove-me');
    expect(result).toBe(true);
    expect(manager.getCapabilities().length).toBe(0);
  });

  it('does not affect other registered tools when deregistering one', () => {
    runtimeRegistrar.register(makeTool('keep-me'), makeConfig());
    runtimeRegistrar.register(makeTool('drop-me'), makeConfig());

    manager.deregisterCapability('drop-me');

    const caps = manager.getCapabilities();
    expect(caps.length).toBe(1);
    expect(caps[0]?.id).toBe('keep-me');
  });
});

describe('RuntimeManager — initialize() and isInitialized()', () => {
  beforeEach(() => {
    for (const rt of runtimeRegistrar.list()) {
      runtimeRegistrar.unregister(rt.tool.id);
    }
  });

  it('isInitialized() returns false before initialization', () => {
    const manager = new RuntimeManager();
    expect(manager.isInitialized()).toBe(false);
  });

  it('initialize() sets isInitialized to true', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();
    expect(manager.isInitialized()).toBe(true);
  });

  it('calling initialize() twice is idempotent', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();
    await manager.initialize(); // second call should be no-op
    expect(manager.isInitialized()).toBe(true);
  });
});

describe('RuntimeManager — shutdown()', () => {
  it('resets isInitialized to false after shutdown', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();
    await manager.shutdown();
    expect(manager.isInitialized()).toBe(false);
  });

  it('can be called without prior initialization', async () => {
    const manager = new RuntimeManager();
    await expect(manager.shutdown()).resolves.not.toThrow();
  });
});

describe('RuntimeManager — getStatus()', () => {
  it('returns a status object with expected shape', async () => {
    const manager = new RuntimeManager();
    const status = manager.getStatus();
    expect(typeof status.healthy).toBe('boolean');
    expect(Array.isArray(status.subsystems)).toBe(true);
    expect(typeof status.installedTools).toBe('number');
    expect(typeof status.runningTools).toBe('number');
    expect(typeof status.timestamp).toBe('string');
  });

  it('reports installed tool count', () => {
    const manager = new RuntimeManager();
    runtimeRegistrar.register(makeTool('status-tool-1'), makeConfig());
    const status = manager.getStatus();
    expect(status.installedTools).toBeGreaterThanOrEqual(1);
    runtimeRegistrar.unregister('status-tool-1');
  });

  it('subsystems array contains expected subsystem names', () => {
    const manager = new RuntimeManager();
    const status = manager.getStatus();
    const names = status.subsystems.map((s) => s.name);
    expect(names).toContain('installer');
    expect(names).toContain('registry');
    expect(names).toContain('policy-engine');
    expect(names).toContain('provider-router');
    expect(names).toContain('workflow-engine');
    expect(names).toContain('scheduler');
  });
});

describe('RuntimeManager — handleRequest()', () => {
  it('handles a simple request and returns a result', async () => {
    const manager = new RuntimeManager();
    const request: NormalizedRequest = {
      id: 'req-1',
      method: 'test-method',
      params: {},
      clientType: 'mcp',
      timestamp: new Date(),
    };
    const result = await manager.handleRequest(request);
    expect(result).toBeDefined();
  });

  it('propagates errors from execution planner', async () => {
    const { executionPlanner } = require('../src/orchestration/execution-planner');
    const mockPlan = executionPlanner.plan as jest.Mock;
    mockPlan.mockRejectedValueOnce(new Error('Plan failed'));

    const manager = new RuntimeManager();
    const request: NormalizedRequest = {
      id: 'req-err',
      method: 'error-method',
      params: {},
      clientType: 'mcp',
      timestamp: new Date(),
    };
    await expect(manager.handleRequest(request)).rejects.toThrow('Plan failed');
  });
});
