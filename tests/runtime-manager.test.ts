/**
 * tests/runtime-manager.test.ts
 * Unit tests for RuntimeManager — getCapabilities() and deregisterCapability().
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

import { RuntimeManager } from '../src/core/runtime-manager';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import type { ToolMetadata } from '../src/discovery/types';
import type { ToolRuntimeConfig } from '../src/provisioning/config-generator';

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
