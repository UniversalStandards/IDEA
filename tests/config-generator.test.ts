/**
 * tests/config-generator.test.ts
 * Unit tests for src/provisioning/config-generator.ts
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import * as path from 'path';
import { ConfigGenerator } from '../src/provisioning/config-generator';
import type { ToolMetadata } from '../src/discovery/types';

function baseTool(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 'tool-1',
    name: 'my-tool',
    version: '1.0.0',
    description: 'A test tool',
    source: 'local',
    capabilities: [],
    tags: [],
    ...overrides,
  };
}

describe('ConfigGenerator — generate()', () => {
  let gen: ConfigGenerator;

  beforeEach(() => {
    gen = new ConfigGenerator();
  });

  it('returns a config with default timeout when no metadata timeout', () => {
    const cfg = gen.generate(baseTool(), {});
    expect(cfg.timeout).toBe(30_000);
  });

  it('uses metadata timeout when provided', () => {
    const cfg = gen.generate(baseTool({ metadata: { timeout: 60_000 } }), {});
    expect(cfg.timeout).toBe(60_000);
  });

  it('uses higher timeout for browser automation tools', () => {
    const cfg = gen.generate(baseTool({ capabilities: ['navigate', 'screenshot'] }), {});
    expect(cfg.timeout).toBe(60_000);
  });

  it('ignores non-positive metadata timeout', () => {
    const cfg = gen.generate(baseTool({ metadata: { timeout: 0 } }), {});
    expect(cfg.timeout).toBe(30_000);
  });

  it('uses entryPoint for workingDir when provided', () => {
    const tool = baseTool({ entryPoint: '/some/path/tool/index.js' });
    const cfg = gen.generate(tool, {});
    expect(cfg.workingDir).toBe(path.dirname('/some/path/tool/index.js'));
  });

  it('uses tool name directory when no entryPoint', () => {
    const cfg = gen.generate(baseTool({ name: 'my-tool' }), {});
    expect(cfg.workingDir).toContain('my-tool');
  });

  it('injects passed credentials into env', () => {
    const cfg = gen.generate(baseTool(), { MY_TOKEN: 'abc123' });
    expect(cfg.env['MY_TOKEN']).toBe('abc123');
  });

  it('auto-maps GITHUB_TOKEN for github tool name', () => {
    process.env['GITHUB_TOKEN'] = 'gh-token';
    const cfg = gen.generate(baseTool({ name: 'github' }), {});
    expect(cfg.env['GITHUB_TOKEN']).toBe('gh-token');
    delete process.env['GITHUB_TOKEN'];
  });

  it('does not override passed credentials with env auto-map', () => {
    process.env['GITHUB_TOKEN'] = 'env-token';
    const cfg = gen.generate(baseTool({ name: 'github' }), { GITHUB_TOKEN: 'passed-token' });
    expect(cfg.env['GITHUB_TOKEN']).toBe('passed-token');
    delete process.env['GITHUB_TOKEN'];
  });

  it('merges metadata env overrides', () => {
    const cfg = gen.generate(baseTool({ metadata: { env: { EXTRA_KEY: 'extra-val' } } }), {});
    expect(cfg.env['EXTRA_KEY']).toBe('extra-val');
  });

  it('does not override existing env with metadata env', () => {
    const cfg = gen.generate(baseTool({ metadata: { env: { MY_KEY: 'from-meta' } } }), { MY_KEY: 'from-creds' });
    expect(cfg.env['MY_KEY']).toBe('from-creds');
  });

  it('returns empty args array when no metadata args', () => {
    const cfg = gen.generate(baseTool(), {});
    expect(cfg.args).toEqual([]);
  });

  it('uses metadata args when provided', () => {
    const cfg = gen.generate(baseTool({ metadata: { args: ['--port', '8080'] } }), {});
    expect(cfg.args).toEqual(['--port', '8080']);
  });

  it('filters non-string metadata args', () => {
    const cfg = gen.generate(baseTool({ metadata: { args: ['valid', 123, null, 'also-valid'] } }), {});
    expect(cfg.args).toEqual(['valid', 'also-valid']);
  });

  it('ignores non-object metadata env', () => {
    const cfg = gen.generate(baseTool({ metadata: { env: 'not-an-object' } }), {});
    // Should not throw and should have empty env (no overrides)
    expect(cfg.env).toBeDefined();
  });
});

describe('ConfigGenerator — generateClientConfig()', () => {
  let gen: ConfigGenerator;

  beforeEach(() => {
    gen = new ConfigGenerator();
  });

  it('returns mcpServers object', () => {
    const result = gen.generateClientConfig([]) as { mcpServers: Record<string, unknown> };
    expect(result.mcpServers).toBeDefined();
    expect(Object.keys(result.mcpServers).length).toBe(0);
  });

  it('skips tools with no resolved command', () => {
    // A tool with no installCommand, no entryPoint, no metadata.command, not local source
    const tool = baseTool({ source: 'official' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers).length).toBe(0);
  });

  it('includes tools with installCommand', () => {
    const tool = baseTool({ installCommand: 'npx my-tool --flag' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers).length).toBe(1);
    const serverEntry = Object.values(result.mcpServers)[0] as { command: string; args: string[] };
    expect(serverEntry.command).toBe('npx');
    expect(serverEntry.args).toContain('my-tool');
  });

  it('includes tools with entryPoint', () => {
    const tool = baseTool({ entryPoint: '/some/path/index.js' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers).length).toBe(1);
    const serverEntry = Object.values(result.mcpServers)[0] as { command: string; args: string[] };
    expect(serverEntry.command).toBe('node');
    expect(serverEntry.args).toContain('/some/path/index.js');
  });

  it('includes local source tools with just a name', () => {
    const tool = baseTool({ name: 'my-local-tool', source: 'local' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers).length).toBe(1);
  });

  it('includes tools with metadata command', () => {
    const tool = baseTool({ metadata: { command: 'node /custom/path/index.js' }, source: 'official' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers).length).toBe(1);
    const serverEntry = Object.values(result.mcpServers)[0] as { command: string };
    expect(serverEntry.command).toBe('node');
  });

  it('sanitizes tool names in server keys', () => {
    const tool = baseTool({ name: 'my tool! @#$', installCommand: 'node index.js' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    const key = Object.keys(result.mcpServers)[0] ?? '';
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('omits env field when no env vars are set', () => {
    const tool = baseTool({ installCommand: 'node index.js' });
    const result = gen.generateClientConfig([tool]) as { mcpServers: Record<string, unknown> };
    const serverEntry = Object.values(result.mcpServers)[0] as { env?: unknown };
    expect(serverEntry.env).toBeUndefined();
  });
});
