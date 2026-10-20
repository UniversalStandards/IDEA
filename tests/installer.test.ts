/**
 * tests/installer.test.ts
 * Unit tests for src/provisioning/installer.ts. npm is mocked; the install
 * directory, state file and runtime registration are real (temp dirs).
 */

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual<typeof import('child_process')>('child_process'),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn() },
}));
jest.mock('../src/security/audit', () => ({ auditLog: { record: jest.fn() } }));

const mockSettings = { allowScripts: false };
jest.mock('../src/config', () => ({
  config: {
    MAX_CONCURRENT_INSTALLS: 2,
    get INSTALL_ALLOW_LIFECYCLE_SCRIPTS(): boolean {
      return mockSettings.allowScripts;
    },
    INSTALL_TIMEOUT_MS: 60_000,
    HUB_DATA_DIR: undefined,
  },
  resolveHubDataDir: (cfg: { HUB_DATA_DIR?: string }) => cfg.HUB_DATA_DIR ?? '/tmp/unused-hub-data',
}));

const mockEvaluate = jest.fn();
jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: { evaluate: (...a: unknown[]) => mockEvaluate(...a) },
}));
const mockTrust = { score: 80, level: 'high', min: 50 };
jest.mock('../src/policy/trust-evaluator', () => ({
  trustEvaluator: {
    evaluate: () => ({ score: mockTrust.score, level: mockTrust.level }),
    getMinimumRequired: () => mockTrust.min,
  },
}));
const mockApproval = jest.fn();
jest.mock('../src/policy/approval-gates', () => ({
  approvalGate: { request: (...a: unknown[]) => mockApproval(...a) },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Installer, packagesForTool, safeInstallDirName, unlaunchableReason } from '../src/provisioning/installer';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import type { ToolMetadata } from '../src/discovery/types';

const TOOL: ToolMetadata = {
  id: 'official:memory',
  name: 'memory',
  version: '0.6.2',
  description: 'Memory',
  source: 'official',
  installCommand: 'npx -y @modelcontextprotocol/server-memory',
  capabilities: [],
  tags: [],
};

let dir: string;
let installer: Installer;

function npmSucceeds(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) =>
    cb(null, { stdout: 'added 1 package', stderr: '' }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.allowScripts = false;
  mockTrust.score = 80;
  mockTrust.min = 50;
  mockEvaluate.mockReturnValue({ allowed: true, requiresApproval: false, reasons: ['[ALLOW]'] });
  npmSucceeds();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
  installer = new Installer({ baseDir: path.join(dir, 'installed'), stateFile: path.join(dir, 'state.json') });
});

afterEach(() => {
  for (const t of runtimeRegistrar.list()) runtimeRegistrar.unregister(t.tool.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('derives a directory-safe install name', () => {
    expect(safeInstallDirName('memory')).toBe('memory');
    expect(safeInstallDirName('io.github.acme/widgets')).toBe('io.github.acme-widgets');
    expect(safeInstallDirName('../../etc')).toBe('etc');
    expect(safeInstallDirName('...')).toBe('tool');
  });

  it('pre-installs explicit dependencies, or the package an npx command launches', () => {
    expect(packagesForTool(TOOL, ['a@1'])).toEqual(['a@1']);
    expect(packagesForTool(TOOL, [])).toEqual(['@modelcontextprotocol/server-memory']);
    expect(packagesForTool({ ...TOOL, installCommand: 'npx --yes pkg@2.0.0 --flag' }, [])).toEqual(['pkg@2.0.0']);
    expect(packagesForTool({ ...TOOL, installCommand: 'uvx mcp-server-time' }, [])).toEqual([]);
    expect(packagesForTool({ ...TOOL, installCommand: 'npx -y' }, [])).toEqual([]);
    expect(packagesForTool({ ...TOOL, installCommand: 'npx -y $(evil)' }, [])).toEqual([]);
    const noCommand: ToolMetadata = { ...TOOL };
    delete noCommand.installCommand;
    expect(packagesForTool(noCommand, [])).toEqual([]);
  });
});

describe('unlaunchableReason()', () => {
  it('accepts tools with an install command, entry point or metadata.command', () => {
    expect(unlaunchableReason(TOOL)).toBeUndefined();
    const { installCommand: _ic, ...bare } = TOOL;
    expect(unlaunchableReason({ ...bare, entryPoint: '/opt/x/index.js' })).toBeUndefined();
    expect(unlaunchableReason({ ...bare, metadata: { command: 'uvx thing' } })).toBeUndefined();
  });

  it('explains why a tool cannot be launched', () => {
    const { installCommand: _ic, ...bare } = TOOL;
    expect(unlaunchableReason(bare)).toContain('no launch command');
    expect(unlaunchableReason({ ...bare, installCommand: '   ' })).toContain('no launch command');
    expect(unlaunchableReason({ ...TOOL, metadata: { installable: false, unsupportedReason: 'Remote-only server' } })).toBe(
      'Remote-only server',
    );
    expect(unlaunchableReason({ ...TOOL, metadata: { installable: false } })).toBe('marked not installable by its registry');
  });
});

describe('Installer.assess()', () => {
  it('denies tools that can never be launched, before any approval', () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
    const assessment = installer.assess({ ...TOOL, metadata: { installable: false, unsupportedReason: 'Remote-only server' } });
    expect(assessment).toMatchObject({ requiresApproval: false });
    expect(assessment.denied).toBe('Tool official:memory cannot be installed: Remote-only server');
  });

  it('allows a trusted tool when policy allows it', () => {
    expect(installer.assess(TOOL)).toMatchObject({ requiresApproval: false, trustScore: 80, minimumTrust: 50 });
    expect(installer.assess(TOOL).denied).toBeUndefined();
  });

  it('denies outright on an explicit policy deny', () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: false, reasons: ['[DENY] nope'] });
    expect(installer.assess(TOOL).denied).toBe('Policy denied installation: [DENY] nope');
  });

  it('denies low-trust tools that policy would otherwise allow', () => {
    mockTrust.score = 10;
    expect(installer.assess(TOOL).denied).toBe('Trust score 10 below minimum 50 for installation');
  });

  it('requires approval when policy requires it, including for low trust', () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
    mockTrust.score = 10;
    expect(installer.assess(TOOL, 'mcp-client')).toMatchObject({ requiresApproval: true });
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ actor: 'mcp-client', action: 'install' }));
  });
});

describe('Installer.install()', () => {
  it('npm-installs into an isolated directory, registers the tool, and persists state', async () => {
    const result = await installer.install(TOOL, { args: ['/data/ws'] });

    const installDir = path.join(dir, 'installed', 'memory');
    expect(result).toMatchObject({ success: true, path: installDir });
    const [cmd, npmArgs, opts] = mockExecFile.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(cmd).toBe('npm');
    expect(npmArgs).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '@modelcontextprotocol/server-memory']));
    expect(opts.cwd).toBe(installDir);
    expect(opts.env).not.toHaveProperty('JWT_SECRET');
    expect(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf-8'))).toMatchObject({ private: true });

    const registered = runtimeRegistrar.get(TOOL.id);
    expect(registered?.config.workingDir).toBe(installDir);
    expect(registered?.config.args).toEqual(['/data/ws']);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')) as { tools: Array<{ args: string[] }> };
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]?.args).toEqual(['/data/ws']);
    expect(installer.isInstalled(TOOL.id)).toBe(true);
    expect(installer.listInstalled().map((t) => t.tool.id)).toEqual([TOOL.id]);
  });

  it('runs lifecycle scripts only when opted in', async () => {
    mockSettings.allowScripts = true;
    await installer.install(TOOL);
    expect((mockExecFile.mock.calls[0] as [string, string[]])[1]).not.toContain('--ignore-scripts');
  });

  it('skips npm when there is nothing to pre-install', async () => {
    const result = await installer.install({ ...TOOL, id: 'official:time', name: 'time', installCommand: 'uvx mcp-server-time' });
    expect(result.success).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('blocks on the approval gate unless pre-approved', async () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
    mockApproval.mockResolvedValue({ status: 'approved' });

    await installer.install(TOOL);
    expect(mockApproval).toHaveBeenCalledTimes(1);

    await installer.uninstall(TOOL.id);
    await installer.install(TOOL, { preApproved: true });
    expect(mockApproval).toHaveBeenCalledTimes(1);
  });

  it('fails when approval is rejected', async () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: true, reasons: [] });
    mockApproval.mockRejectedValue(new Error('Approval rejected'));
    const result = await installer.install(TOOL);
    expect(result).toMatchObject({ success: false, error: 'Approval denied or timed out: Approval rejected' });
  });

  it('fails on an outright denial without touching npm', async () => {
    mockEvaluate.mockReturnValue({ allowed: false, requiresApproval: false, reasons: ['no'] });
    const result = await installer.install(TOOL);
    expect(result.success).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rolls back a newly created install directory when npm fails', async () => {
    mockExecFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
      cb(new Error('E404 not found')),
    );
    const result = await installer.install(TOOL);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('npm install failed for official:memory: E404 not found');
    expect(fs.existsSync(path.join(dir, 'installed', 'memory'))).toBe(false);
    expect(installer.isInstalled(TOOL.id)).toBe(false);
  });

  it('rejects oversized launch arguments', async () => {
    const result = await installer.install(TOOL, { args: Array.from({ length: 33 }, () => 'x') });
    expect(result).toMatchObject({ success: false, error: 'Too many launch arguments (max 32)' });
    const nul = await installer.install(TOOL, { args: ['a\0b'] });
    expect(nul.success).toBe(false);
  });

  it('shares one operation between concurrent installs of the same tool', async () => {
    const [a, b] = await Promise.all([installer.install(TOOL), installer.install(TOOL)]);
    expect(a).toBe(b);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('keeps tool names from escaping the install base directory', async () => {
    const result = await installer.install({ ...TOOL, id: 'evil', name: '../../outside' });
    expect(result.success).toBe(true);
    expect(result.path?.startsWith(path.join(dir, 'installed'))).toBe(true);
  });
});

describe('multiple hub processes sharing one data directory', () => {
  function sibling(): Installer {
    return new Installer({ baseDir: path.join(dir, 'installed'), stateFile: path.join(dir, 'state.json') });
  }

  it('serializes npm runs for the same tool across installers', async () => {
    let active = 0;
    let maxActive = 0;
    mockExecFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown, r: unknown) => void) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        cb(null, { stdout: '', stderr: '' });
      }, 40);
    });

    const [a, b] = await Promise.all([installer.install(TOOL), sibling().install(TOOL)]);

    expect(a.success && b.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(fs.existsSync(path.join(dir, 'installed', '.locks', 'memory.lock'))).toBe(false);
  });

  it('merges install records instead of overwriting each other', async () => {
    const other = sibling();
    await installer.install(TOOL);
    await other.install({ ...TOOL, id: 'official:time', name: 'time', installCommand: 'uvx mcp-server-time' });

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')) as { tools: Array<{ tool: { id: string } }> };
    expect(state.tools.map((r) => r.tool.id).sort()).toEqual(['official:memory', 'official:time']);

    await installer.uninstall(TOOL.id);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')) as { tools: Array<{ tool: { id: string } }> };
    expect(after.tools.map((r) => r.tool.id)).toEqual(['official:time']);
  });
});

describe('Installer.uninstall() and restore()', () => {
  it('removes the install directory, registration and state', async () => {
    await installer.install(TOOL);
    await installer.uninstall(TOOL.id, 'mcp-client');
    expect(fs.existsSync(path.join(dir, 'installed', 'memory'))).toBe(false);
    expect(runtimeRegistrar.get(TOOL.id)).toBeUndefined();
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')) as { tools: unknown[] };
    expect(state.tools).toEqual([]);
  });

  it('throws for a tool that is not installed', async () => {
    await expect(installer.uninstall('nope')).rejects.toThrow('Tool not installed: nope');
  });

  it('restores installs recorded by a previous process', async () => {
    await installer.install(TOOL, { args: ['--x'] });
    runtimeRegistrar.unregister(TOOL.id);

    const next = new Installer({ baseDir: path.join(dir, 'installed'), stateFile: path.join(dir, 'state.json') });
    expect(next.restore()).toBe(1);
    expect(next.isInstalled(TOOL.id)).toBe(true);
    expect(next.getInstallResult(TOOL.id)?.path).toBe(path.join(dir, 'installed', 'memory'));
    expect(runtimeRegistrar.get(TOOL.id)?.config.args).toEqual(['--x']);
  });

  it('skips records whose directory is missing or outside the base directory', () => {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        tools: [
          { tool: TOOL, args: [], installPath: path.join(dir, 'installed', 'gone'), installedAt: new Date().toISOString() },
          { tool: { ...TOOL, id: 'x' }, args: [], installPath: '/etc', installedAt: new Date().toISOString() },
        ],
      }),
    );
    expect(installer.restore()).toBe(0);
  });

  it('getBaseDir() reports the resolved base directory', () => {
    expect(installer.getBaseDir()).toBe(path.join(dir, 'installed'));
  });
});
