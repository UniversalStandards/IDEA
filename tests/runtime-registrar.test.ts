/**
 * tests/runtime-registrar.test.ts
 * Unit tests for launch specs and process environments in
 * src/provisioning/runtime-registrar.ts.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/security/audit', () => ({ auditLog: { record: jest.fn() } }));
jest.mock('../src/observability/metrics', () => ({ metrics: { increment: jest.fn(), gauge: jest.fn() } }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  RuntimeRegistrar,
  buildInstallerEnv,
  buildToolProcessEnv,
  networkEnv,
} from '../src/provisioning/runtime-registrar';

const baseTool = {
  id: 't:1',
  name: 'one',
  version: '1.0.0',
  description: 'd',
  source: 'official' as const,
  capabilities: [],
  tags: [],
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registrar-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function cfg(over: Partial<{ env: Record<string, string>; args: string[]; workingDir: string; timeout: number }> = {}) {
  return { env: {}, args: [], workingDir: path.join(dir, 'work'), timeout: 30_000, ...over };
}

describe('RuntimeRegistrar.getLaunchSpec()', () => {
  it('returns undefined for unknown tools and tools without a command', () => {
    const r = new RuntimeRegistrar();
    expect(r.getLaunchSpec('nope')).toBeUndefined();
    r.register(baseTool, cfg());
    expect(r.getLaunchSpec('t:1')).toBeUndefined();
  });

  it('splits installCommand and appends configured args, creating the working dir', () => {
    const r = new RuntimeRegistrar();
    r.register({ ...baseTool, installCommand: 'npx -y @scope/pkg@1.0.0' }, cfg({ args: ['/data/ws'], env: { A: '1' } }));

    const spec = r.getLaunchSpec('t:1');

    expect(spec).toEqual({
      command: 'npx',
      args: ['-y', '@scope/pkg@1.0.0', '/data/ws'],
      cwd: path.join(dir, 'work'),
      env: { A: '1' },
      timeoutMs: 30_000,
    });
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(true);
  });

  it('falls back to entryPoint, then metadata.command', () => {
    const r = new RuntimeRegistrar();
    r.register({ ...baseTool, entryPoint: '/opt/tool/index.js' }, cfg());
    expect(r.getLaunchSpec('t:1')).toMatchObject({ command: 'node', args: ['/opt/tool/index.js'] });

    r.register({ ...baseTool, metadata: { command: 'uvx mcp-server-time' } }, cfg());
    expect(r.getLaunchSpec('t:1')).toMatchObject({ command: 'uvx', args: ['mcp-server-time'] });
  });
});

describe('process environments', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    JWT_SECRET: 'hub-secret',
    ENCRYPTION_KEY: 'hub-key',
    MCP_AUTH_TOKEN: 'hub-token',
    OPENAI_API_KEY: 'sk-hub',
    HTTPS_PROXY: 'http://proxy:3128',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    UV_CACHE_DIR: '/data/.cache/uv',
    npm_config_registry: 'https://npm.internal',
    NPM_CONFIG_CAFILE: '/ca.pem',
    EMPTY: '',
  };

  it('networkEnv passes only proxy, trust-store and package-runtime variables', () => {
    expect(networkEnv(source)).toEqual({
      HTTPS_PROXY: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      UV_CACHE_DIR: '/data/.cache/uv',
      npm_config_registry: 'https://npm.internal',
    });
  });

  it('tool processes never inherit hub secrets', () => {
    const env = buildToolProcessEnv({ TOOL_VAR: 'x' }, source);
    expect(env['TOOL_VAR']).toBe('x');
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128');
    for (const secret of ['JWT_SECRET', 'ENCRYPTION_KEY', 'MCP_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      expect(env).not.toHaveProperty(secret);
    }
  });

  it('npm installs additionally receive npm configuration', () => {
    const env = buildInstallerEnv(source);
    expect(env['NPM_CONFIG_CAFILE']).toBe('/ca.pem');
    expect(env['npm_config_registry']).toBe('https://npm.internal');
    expect(env).not.toHaveProperty('JWT_SECRET');
  });
});

describe('RuntimeRegistrar process lifecycle', () => {
  function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (predicate()) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('starts a tool process with an isolated environment and records a clean exit', async () => {
    const r = new RuntimeRegistrar();
    process.env['JWT_SECRET'] = 'must-not-leak';
    try {
      r.register(
        { ...baseTool, metadata: { command: `${process.execPath} -e process.exit(process.env.JWT_SECRET?7:0)` } },
        cfg(),
      );
      const proc = r.start('t:1');
      expect(r.start('t:1')).toBe(proc);
      expect(r.isRunning('t:1')).toBe(true);
      await waitFor(() => r.get('t:1')?.status !== 'running');
      expect(r.get('t:1')?.status).toBe('stopped');
    } finally {
      delete process.env['JWT_SECRET'];
    }
  });

  it('records a non-zero exit as an error', async () => {
    const r = new RuntimeRegistrar();
    r.register({ ...baseTool, metadata: { command: `${process.execPath} -e process.exit(4)` } }, cfg());
    r.start('t:1');
    await waitFor(() => r.get('t:1')?.status === 'error');
    expect(r.get('t:1')?.errorMessage).toContain('code 4');
  });

  it('stops a running process and unregisters tools', async () => {
    const r = new RuntimeRegistrar();
    r.register({ ...baseTool, metadata: { command: `${process.execPath} -e setInterval(()=>{},1000)` } }, cfg());
    r.start('t:1');
    r.stop('t:1');
    expect(r.get('t:1')?.status).toBe('stopped');
    r.stop('t:1');
    r.stop('unknown');
    r.unregister('t:1');
    r.unregister('t:1');
    expect(r.list()).toEqual([]);
  });

  it('refuses to start unknown tools or tools without a command', () => {
    const r = new RuntimeRegistrar();
    expect(() => r.start('missing')).toThrow('Tool not registered: missing');
    r.register(baseTool, cfg());
    expect(() => r.start('t:1')).toThrow('Cannot resolve start command');
  });

  it('records a spawn failure as an error', async () => {
    const r = new RuntimeRegistrar();
    r.register({ ...baseTool, metadata: { command: 'definitely-not-a-command-xyz' } }, cfg());
    r.start('t:1');
    await waitFor(() => r.get('t:1')?.status === 'error');
    expect(r.get('t:1')?.errorMessage).toContain('ENOENT');
  });
});
