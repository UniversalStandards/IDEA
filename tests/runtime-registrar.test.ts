/**
 * tests/runtime-registrar.test.ts
 * Unit tests for src/provisioning/runtime-registrar.ts
 */

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
  },
}));

jest.mock('../src/security/audit', () => ({
  auditLogger: { log: jest.fn() },
}));

import { RuntimeRegistrar } from '../src/provisioning/runtime-registrar';
import type { ToolMetadata } from '../src/discovery/types';
import type { ToolRuntimeConfig } from '../src/provisioning/config-generator';

function makeTool(id: string, overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id,
    name: `Tool ${id}`,
    version: '1.0.0',
    description: `Description for ${id}`,
    source: 'local',
    capabilities: ['execute'],
    tags: ['test'],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ToolRuntimeConfig> = {}): ToolRuntimeConfig {
  return {
    env: {},
    args: [],
    workingDir: '/tmp',
    timeout: 30_000,
    ...overrides,
  };
}

describe('RuntimeRegistrar — register()', () => {
  let registrar: RuntimeRegistrar;

  beforeEach(() => {
    registrar = new RuntimeRegistrar();
  });

  it('registers a tool and returns entry with registered status', () => {
    const entry = registrar.register(makeTool('t1'), makeConfig());
    expect(entry.status).toBe('registered');
    expect(entry.tool.id).toBe('t1');
  });

  it('re-registers an existing tool without error', () => {
    registrar.register(makeTool('t2'), makeConfig());
    const entry = registrar.register(makeTool('t2'), makeConfig());
    expect(entry.status).toBe('registered');
  });

  it('get() returns the registered tool', () => {
    registrar.register(makeTool('t3'), makeConfig());
    const found = registrar.get('t3');
    expect(found).toBeDefined();
    expect(found?.tool.id).toBe('t3');
  });

  it('get() returns undefined for unknown tool', () => {
    expect(registrar.get('nonexistent')).toBeUndefined();
  });

  it('list() returns all registered tools', () => {
    registrar.register(makeTool('a1'), makeConfig());
    registrar.register(makeTool('a2'), makeConfig());
    expect(registrar.list().length).toBe(2);
  });

  it('isRunning() returns false for a registered (not started) tool', () => {
    registrar.register(makeTool('t4'), makeConfig());
    expect(registrar.isRunning('t4')).toBe(false);
  });

  it('isRunning() returns false for an unknown tool', () => {
    expect(registrar.isRunning('unknown')).toBe(false);
  });
});

describe('RuntimeRegistrar — unregister()', () => {
  let registrar: RuntimeRegistrar;

  beforeEach(() => {
    registrar = new RuntimeRegistrar();
  });

  it('removes a registered tool', () => {
    registrar.register(makeTool('u1'), makeConfig());
    registrar.unregister('u1');
    expect(registrar.get('u1')).toBeUndefined();
  });

  it('silently handles unregistering an unknown tool', () => {
    expect(() => registrar.unregister('no-such-tool')).not.toThrow();
  });

  it('decrements list count after unregister', () => {
    registrar.register(makeTool('u2'), makeConfig());
    registrar.register(makeTool('u3'), makeConfig());
    registrar.unregister('u2');
    expect(registrar.list().length).toBe(1);
  });
});

describe('RuntimeRegistrar — stop()', () => {
  let registrar: RuntimeRegistrar;

  beforeEach(() => {
    registrar = new RuntimeRegistrar();
  });

  it('silently handles stopping an unknown tool', () => {
    expect(() => registrar.stop('unknown-tool')).not.toThrow();
  });

  it('silently handles stopping a registered (not running) tool', () => {
    registrar.register(makeTool('s1'), makeConfig());
    expect(() => registrar.stop('s1')).not.toThrow();
  });
});

describe('RuntimeRegistrar — start()', () => {
  let registrar: RuntimeRegistrar;

  beforeEach(() => {
    registrar = new RuntimeRegistrar();
  });

  it('throws when starting an unregistered tool', () => {
    expect(() => registrar.start('not-registered')).toThrow('Tool not registered');
  });

  it('throws when no start command can be resolved', () => {
    // Tool with no installCommand, no entryPoint, no metadata command
    registrar.register(
      makeTool('no-cmd', { source: 'official' }),
      makeConfig(),
    );
    expect(() => registrar.start('no-cmd')).toThrow('Cannot resolve start command');
  });

  it('starts a tool with installCommand and returns a process', () => {
    registrar.register(
      makeTool('with-cmd', { installCommand: 'node --version' }),
      makeConfig(),
    );
    const proc = registrar.start('with-cmd');
    expect(proc).toBeDefined();
    expect(typeof proc.pid === 'number' || proc.pid === undefined).toBe(true);

    // Clean up
    try {
      proc.kill();
    } catch {
      // ignore
    }
  });

  it('starts a tool with entryPoint and returns a process', () => {
    registrar.register(
      makeTool('with-entry', { entryPoint: '/dev/null' }),
      makeConfig(),
    );
    const proc = registrar.start('with-entry');
    expect(proc).toBeDefined();
    try { proc.kill(); } catch { /* ignore */ }
  });

  it('starts a tool with metadata command', () => {
    registrar.register(
      makeTool('with-meta-cmd', { source: 'official', metadata: { command: 'node --version' } }),
      makeConfig(),
    );
    const proc = registrar.start('with-meta-cmd');
    expect(proc).toBeDefined();
    try { proc.kill(); } catch { /* ignore */ }
  });

  it('returns existing process when tool is already running', () => {
    registrar.register(
      makeTool('already-running', { installCommand: 'node --version' }),
      makeConfig(),
    );
    const proc1 = registrar.start('already-running');
    // Manually mark as running
    const entry = registrar.get('already-running');
    if (entry) {
      entry.status = 'running';
      entry.process = proc1;
    }
    const proc2 = registrar.start('already-running');
    expect(proc2).toBe(proc1);
    try { proc1.kill(); } catch { /* ignore */ }
  });
});

describe('RuntimeRegistrar — start() with metadata command', () => {
  let registrar: RuntimeRegistrar;

  beforeEach(() => {
    registrar = new RuntimeRegistrar();
  });

  it('handles installCommand with extra args', () => {
    registrar.register(
      makeTool('cmd-args', { installCommand: 'node -e "process.exit(0)"' }),
      makeConfig({ args: ['--extra'] }),
    );
    const proc = registrar.start('cmd-args');
    expect(proc).toBeDefined();
    try { proc.kill(); } catch { /* ignore */ }
  });
});
