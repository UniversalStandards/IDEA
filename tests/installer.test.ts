/**
 * tests/installer.test.ts
 * Unit tests for src/provisioning/installer.ts
 */

jest.mock('../src/config', () => ({
  config: {
    MAX_CONCURRENT_INSTALLS: 5,
    NODE_ENV: 'test',
  },
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
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
    gauge: jest.fn(),
  },
}));

jest.mock('../src/security/audit', () => ({
  auditLogger: { log: jest.fn() },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: {
    evaluate: jest.fn().mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] }),
  },
}));

jest.mock('../src/policy/trust-evaluator', () => ({
  trustEvaluator: {
    evaluate: jest.fn().mockReturnValue({ score: 90, level: 'high', factors: [] }),
    getMinimumRequired: jest.fn().mockReturnValue(70),
  },
}));

jest.mock('../src/policy/approval-gates', () => ({
  approvalGate: {
    request: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/provisioning/dependency-resolver', () => ({
  dependencyResolver: {
    resolve: jest.fn().mockReturnValue({ packages: [], conflicts: [], installOrder: [] }),
  },
}));

jest.mock('../src/provisioning/config-generator', () => ({
  configGenerator: {
    generate: jest.fn().mockReturnValue({ env: {}, args: [], workingDir: '', timeout: 30000 }),
  },
}));

jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: {
    register: jest.fn(),
    unregister: jest.fn(),
    list: jest.fn().mockReturnValue([]),
  },
}));

// Mock the entire 'fs' module (sync + promise APIs)
jest.mock('fs', () => {
  const fakePromises = {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn().mockResolvedValue({ size: 100, isFile: () => true, isDirectory: () => false }),
  };
  return {
    promises: fakePromises,
    mkdirSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    writeFileSync: jest.fn(),
  };
});

jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  return {
    spawn: jest.fn().mockImplementation(() => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr, kill: jest.fn() });
      process.nextTick(() => child.emit('close', 0));
      return child;
    }),
  };
});

import { Installer } from '../src/provisioning/installer';
import type { ToolMetadata } from '../src/discovery/types';
import * as fsMod from 'fs';

const fsp = (fsMod as unknown as { promises: Record<string, jest.Mock> }).promises;

function makeTool(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 'test-tool-id',
    name: 'test-tool',
    version: '1.0.0',
    description: 'A test tool',
    source: 'official',
    capabilities: ['chat'],
    tags: [],
    verified: true,
    ...overrides,
  };
}

describe('Installer', () => {
  let installer: Installer;

  beforeEach(() => {
    jest.clearAllMocks();

    // Restore default mock behaviour after each test
    fsp['mkdir']!.mockResolvedValue(undefined);
    fsp['writeFile']!.mockResolvedValue(undefined);
    fsp['unlink']!.mockResolvedValue(undefined);
    fsp['rm']!.mockResolvedValue(undefined);
    fsp['readdir']!.mockResolvedValue([]);

    const { policyEngine } = require('../src/policy/policy-engine') as {
      policyEngine: { evaluate: jest.Mock };
    };
    policyEngine.evaluate.mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] });

    installer = new Installer();
  });

  it('dry-run returns success result without executing npm', async () => {
    const { spawn } = require('child_process') as { spawn: jest.Mock };
    const tool = makeTool();

    const result = await installer.install(tool, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('successful install flow with dryRun skips npm and returns success', async () => {
    const tool = makeTool();

    const result = await installer.install(tool, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.tool.id).toBe('test-tool-id');
  });

  it('returns failure when policy denies the install', async () => {
    const { policyEngine } = require('../src/policy/policy-engine') as {
      policyEngine: { evaluate: jest.Mock };
    };
    policyEngine.evaluate.mockReturnValue({
      allowed: false,
      requiresApproval: false,
      reasons: ['blocked by policy'],
    });

    const tool = makeTool();
    const result = await installer.install(tool, { dryRun: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/policy denied/i);
  });

  it('returns failure when install lock is already held for the tool', async () => {
    const lockError = Object.assign(new Error('EEXIST: file exists'), { code: 'EEXIST' });
    fsp['writeFile']!.mockRejectedValueOnce(lockError);

    const tool = makeTool();
    const result = await installer.install(tool);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lock already held/i);
  });

  it('failed npm install triggers rollback of install directory', async () => {
    const { spawn } = require('child_process') as { spawn: jest.Mock };
    const { EventEmitter } = require('events') as typeof import('events');
    const { dependencyResolver } = require('../src/provisioning/dependency-resolver') as {
      dependencyResolver: { resolve: jest.Mock };
    };

    type MockChild = InstanceType<typeof EventEmitter> & {
      stdout: InstanceType<typeof EventEmitter>;
      stderr: InstanceType<typeof EventEmitter>;
      kill: jest.Mock;
    };

    // Make the tool have a real package to install so npmInstall calls spawn
    dependencyResolver.resolve.mockReturnValueOnce({
      packages: ['failing-tool@1.0.0'],
      conflicts: [],
      installOrder: ['failing-tool@1.0.0'],
    });

    // Override spawn to simulate npm failing (exit code 1 with stderr)
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as MockChild;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr, kill: jest.fn() });
      process.nextTick(() => {
        stderr.emit('data', Buffer.from('npm ERR! code E404'));
        child.emit('close', 1);
      });
      return child;
    });

    const tool = makeTool({
      id: 'failing-tool',
      name: 'failing-tool',
    });

    const result = await installer.install(tool, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // rollback() calls fsp.rm to clean up the install directory
    expect(fsp['rm']).toHaveBeenCalled();
  });

  it('checksum mismatch returns failure and triggers rollback', async () => {
    const tool = makeTool();

    // fsp.readdir returns [] → computed checksum = sha256('') which won't match 'wrong-hash'
    fsp['readdir']!.mockResolvedValue([]);

    const result = await installer.install(tool, {
      dryRun: false,
      expectedSha256: 'wrong-hash-that-will-not-match',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/checksum mismatch/i);
    // rollback calls fsp.rm
    expect(fsp['rm']).toHaveBeenCalled();
  });

  it('isInstalled returns false for a tool only run via dry-run', async () => {
    const tool = makeTool({ id: 'tool-abc' });
    // dry-run validates but does not persist to installed map
    await installer.install(tool, { dryRun: true });
    expect(installer.isInstalled('tool-abc')).toBe(false);
  });

  it('getInstallResult returns undefined for unknown tool', () => {
    expect(installer.getInstallResult('unknown-tool')).toBeUndefined();
  });

  it('getInstallResult returns undefined for a dry-run (no state persisted)', async () => {
    const tool = makeTool({ id: 'tool-res' });
    await installer.install(tool, { dryRun: true });
    // dry-run does not persist to installed map
    expect(installer.getInstallResult('tool-res')).toBeUndefined();
  });

  it('listInstalled returns empty array initially', () => {
    expect(installer.listInstalled()).toEqual([]);
  });

  it('uninstall throws when tool is not installed', async () => {
    await expect(installer.uninstall('not-installed-tool')).rejects.toThrow(/not installed/i);
  });

  it('emits "install:stage" event during dry-run', async () => {
    const tool = makeTool({ id: 'emit-tool' });
    const stages: string[] = [];
    installer.on('install:stage', ({ stage }: { stage: string }) => stages.push(stage));
    await installer.install(tool, { dryRun: true });
    expect(stages).toContain('dry-run-complete');
  });

  it('emits "failed" event on policy denial', async () => {
    const { policyEngine } = require('../src/policy/policy-engine') as {
      policyEngine: { evaluate: jest.Mock };
    };
    policyEngine.evaluate.mockReturnValue({ allowed: false, requiresApproval: false, reasons: ['blocked'] });

    const tool = makeTool({ id: 'fail-tool' });
    const listener = jest.fn();
    installer.on('failed', listener);
    await installer.install(tool, { dryRun: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('locks are acquired and released during normal install', async () => {
    const tool = makeTool({ id: 'lock-tool' });
    await installer.install(tool, { dryRun: true });
    // writeFile called to create lock, unlink called to release it
    expect(fsp['writeFile']).toHaveBeenCalled();
    expect(fsp['unlink']).toHaveBeenCalled();
  });

  it('lock error that is not EEXIST propagates as failure', async () => {
    const otherError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fsp['writeFile']!.mockRejectedValueOnce(otherError);

    const tool = makeTool({ id: 'perm-tool' });
    const result = await installer.install(tool);
    expect(result.success).toBe(false);
  });

  it('full install (non-dry-run, no npm packages) succeeds and registers tool', async () => {
    const tool = makeTool({ id: 'full-install-tool' });

    const result = await installer.install(tool, { dryRun: false });

    expect(result.success).toBe(true);
    expect(installer.isInstalled('full-install-tool')).toBe(true);
    expect(installer.getInstallResult('full-install-tool')).toMatchObject({ success: true });
  });

  it('uninstall removes tool from installed map when directory does not exist', async () => {
    const tool = makeTool({ id: 'uninstall-tool' });

    // First do a full install to populate the installed map
    await installer.install(tool, { dryRun: false });
    expect(installer.isInstalled('uninstall-tool')).toBe(true);

    // directory does not exist (existsSync mocked to false), so no npm uninstall called
    const uninstallListener = jest.fn();
    installer.on('uninstalled', uninstallListener);
    await installer.uninstall('uninstall-tool');

    expect(installer.isInstalled('uninstall-tool')).toBe(false);
    expect(uninstallListener).toHaveBeenCalledWith('uninstall-tool');
  });

  it('uninstall removes directory when existsSync returns true', async () => {
    const { spawn } = require('child_process') as { spawn: jest.Mock };
    const { EventEmitter } = require('events') as typeof import('events');
    const fsSyncMod = require('fs') as { existsSync: jest.Mock };

    const tool = makeTool({ id: 'uninstall-dir-tool' });

    // Full install first
    await installer.install(tool, { dryRun: false });

    // Make existsSync return true for directory removal path
    fsSyncMod.existsSync.mockReturnValueOnce(true);

    // npm uninstall spawn succeeds
    type MockChild = InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter>; stderr: InstanceType<typeof EventEmitter>; kill: jest.Mock };
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as MockChild;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr, kill: jest.fn() });
      process.nextTick(() => child.emit('close', 0));
      return child;
    });

    await installer.uninstall('uninstall-dir-tool');
    expect(installer.isInstalled('uninstall-dir-tool')).toBe(false);
    expect(fsp['rm']).toHaveBeenCalled();
  });
});
