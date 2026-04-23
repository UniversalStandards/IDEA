/**
 * tests/installer.test.ts
 * Unit tests for src/provisioning/installer.ts
 *
 * Tests cover:
 *  - Successful install flow
 *  - Rollback on failure
 *  - Concurrent installs of the same package are serialized
 *  - Dry-run returns a plan without executing filesystem writes
 *  - Checksum mismatch throws and triggers rollback
 */

// ── Module mocks (must come before imports) ──────────────────────────────────

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
    gauge: jest.fn(),
  },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: {
    evaluate: jest.fn().mockReturnValue({
      allowed: true,
      requiresApproval: false,
      reasons: [],
    }),
  },
}));

jest.mock('../src/policy/trust-evaluator', () => ({
  trustEvaluator: {
    evaluate: jest.fn().mockReturnValue({ score: 80, level: 'high' }),
    getMinimumRequired: jest.fn().mockReturnValue(50),
  },
}));

jest.mock('../src/policy/approval-gates', () => ({
  approvalGate: {
    request: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/provisioning/dependency-resolver', () => ({
  dependencyResolver: {
    resolve: jest.fn().mockReturnValue({
      packages: [],
      conflicts: [],
      installOrder: [],
    }),
  },
}));

jest.mock('../src/provisioning/config-generator', () => ({
  configGenerator: {
    generate: jest.fn().mockReturnValue({
      env: {},
      args: [],
      workingDir: '/tmp/mock-tool',
      timeout: 30_000,
    }),
  },
}));

jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: {
    register: jest.fn().mockReturnValue({}),
    unregister: jest.fn(),
    list: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../src/config', () => ({
  config: {
    MAX_CONCURRENT_INSTALLS: 5,
  },
}));

// Mock specific fs methods so they can be controlled per-test.
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  rmSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Installer } from '../src/provisioning/installer';
import type { ToolMetadata } from '../src/discovery/types';
import { auditLog } from '../src/security/audit';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_INSTALL_PATH = '/mock/.mcp/installed/test-tool';

/** Type that exposes `npmInstall` as a public method for spy purposes only. */
type TestableInstaller = { npmInstall: (tool: ToolMetadata, packages: string[], dir: string) => Promise<string> };

const makeTool = (overrides: Partial<ToolMetadata> = {}): ToolMetadata => ({
  id: 'tool-test-id',
  name: 'test-tool',
  version: '1.0.0',
  description: 'A test tool',
  source: 'official',
  capabilities: [],
  tags: [],
  ...overrides,
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Installer', () => {
  let installer: Installer;
  let spyNpmInstall: jest.SpyInstance<Promise<string>, [ToolMetadata, string[], string]>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a fresh Installer for each test so internal state doesn't bleed.
    installer = new Installer();

    // Spy on the private npmInstall to prevent real npm invocations.
    spyNpmInstall = jest
      .spyOn(installer as unknown as TestableInstaller, 'npmInstall')
      .mockResolvedValue(MOCK_INSTALL_PATH);

    // Reset fs mock default behaviours after clearAllMocks.
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Successful install ──────────────────────────────────────────────────────

  it('completes a successful install and emits install:complete', async () => {
    const tool = makeTool();
    const events: string[] = [];

    installer.on('install:start', () => events.push('install:start'));
    installer.on('install:download', () => events.push('install:download'));
    installer.on('install:verify', () => events.push('install:verify'));
    installer.on('install:extract', () => events.push('install:extract'));
    installer.on('install:register', () => events.push('install:register'));
    installer.on('install:complete', () => events.push('install:complete'));

    const result = await installer.install(tool);

    expect(result.success).toBe(true);
    expect(result.path).toBe(MOCK_INSTALL_PATH);
    expect(result.error).toBeUndefined();
    expect(events).toEqual([
      'install:start',
      'install:download',
      'install:verify',
      'install:extract',
      'install:register',
      'install:complete',
    ]);
    expect(installer.isInstalled(tool.id)).toBe(true);
  });

  it('writes and removes the lock file during a successful install', async () => {
    const tool = makeTool();

    await installer.install(tool);

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('locks'), {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`${tool.name}.lock`),
      expect.any(String),
      'utf-8',
    );
    // Lock file is removed after install (rmSync called with lock path)
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(`${tool.name}.lock`),
      expect.objectContaining({ force: true }),
    );
  });

  it('records audit events for a successful install', async () => {
    const tool = makeTool();
    await installer.install(tool);

    const mockRecord = auditLog.record as jest.Mock;
    const actions = mockRecord.mock.calls.map((c) => c[0] as string);

    expect(actions).toContain('install.start');
    expect(actions).toContain('install.download');
    expect(actions).toContain('install.verify');
    expect(actions).toContain('install.extract');
    expect(actions).toContain('install.register');
    expect(actions).toContain('tool.install');
  });

  // ── Rollback on failure ─────────────────────────────────────────────────────

  it('rolls back the install directory when npmInstall fails', async () => {
    const tool = makeTool();

    jest
      .spyOn(installer as unknown as TestableInstaller, 'npmInstall')
      .mockRejectedValue(new Error('npm ERR! network timeout'));

    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const rollbackEvents: string[] = [];
    installer.on('install:rollback', () => rollbackEvents.push('install:rollback'));

    const result = await installer.install(tool);

    expect(result.success).toBe(false);
    expect(result.error).toContain('npm ERR!');
    expect(rollbackEvents).toEqual(['install:rollback']);
    // rmSync should have been called for the install directory
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(tool.name),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('emits install:rollback and records audit entry on rollback', async () => {
    const tool = makeTool();

    jest
      .spyOn(installer as unknown as TestableInstaller, 'npmInstall')
      .mockRejectedValue(new Error('download failed'));

    (fs.existsSync as jest.Mock).mockReturnValue(true);

    await installer.install(tool);

    const mockRecord = auditLog.record as jest.Mock;
    const rollbackCall = mockRecord.mock.calls.find((c) => c[0] === 'install.rollback');
    expect(rollbackCall).toBeDefined();
    expect(rollbackCall?.[3]).toBe('failure');
  });

  // ── Dry-run ─────────────────────────────────────────────────────────────────

  it('dry-run returns a plan object without writing to the filesystem', async () => {
    const tool = makeTool();

    const result = await installer.install(tool, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan?.dryRun).toBe(true);
    expect(result.plan?.tool.id).toBe(tool.id);
    expect(Array.isArray(result.plan?.steps)).toBe(true);
    expect(result.plan?.steps.length).toBeGreaterThan(0);

    // No filesystem lock file should have been created
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.lock'),
      expect.anything(),
      expect.anything(),
    );
    // npmInstall must not be called in dry-run
    expect(spyNpmInstall).not.toHaveBeenCalled();
  });

  it('dry-run includes the resolved packages in the plan', async () => {
    const { dependencyResolver } = jest.requireMock('../src/provisioning/dependency-resolver') as {
      dependencyResolver: { resolve: jest.Mock };
    };
    dependencyResolver.resolve.mockReturnValueOnce({
      packages: ['lodash@4.17.21'],
      conflicts: [],
      installOrder: ['lodash@4.17.21'],
    });

    const tool = makeTool({ dependencies: ['lodash@4.17.21'] });
    const result = await installer.install(tool, { dryRun: true });

    expect(result.plan?.packages).toContain('lodash@4.17.21');
  });

  it('dry-run does not register the tool in the runtime', async () => {
    const { runtimeRegistrar } = jest.requireMock('../src/provisioning/runtime-registrar') as {
      runtimeRegistrar: { register: jest.Mock };
    };

    const tool = makeTool();
    await installer.install(tool, { dryRun: true });

    expect(runtimeRegistrar.register).not.toHaveBeenCalled();
    expect(installer.isInstalled(tool.id)).toBe(false);
  });

  // ── Checksum verification ───────────────────────────────────────────────────

  it('passes checksum verification when digests match', async () => {
    const content = Buffer.from('{"name":"test-tool","version":"1.0.0"}');
    const validChecksum = crypto.createHash('sha256').update(content).digest('hex');

    jest.spyOn(fs, 'readFileSync').mockReturnValue(content);

    const tool = makeTool();
    const result = await installer.install(tool, { expectedChecksum: validChecksum });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('fails and rolls back when checksum does not match', async () => {
    const content = Buffer.from('{"name":"test-tool","version":"1.0.0"}');
    const wrongChecksum = 'deadbeef'.repeat(8); // 64 hex chars but wrong

    jest.spyOn(fs, 'readFileSync').mockReturnValue(content);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const rollbackEvents: string[] = [];
    installer.on('install:rollback', () => rollbackEvents.push('install:rollback'));

    const tool = makeTool();
    const result = await installer.install(tool, { expectedChecksum: wrongChecksum });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
    expect(rollbackEvents).toEqual(['install:rollback']);
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(tool.name),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('reads checksum from tool.metadata.checksumSha256 when no option is provided', async () => {
    const content = Buffer.from('{"name":"test-tool"}');
    const wrongChecksum = 'aaaa'.repeat(16); // wrong checksum

    jest.spyOn(fs, 'readFileSync').mockReturnValue(content);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const tool = makeTool({ metadata: { checksumSha256: wrongChecksum } });
    const result = await installer.install(tool);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
  });

  it('skips checksum when neither option nor metadata checksum is provided', async () => {
    const readFileSpy = jest.spyOn(fs, 'readFileSync');

    const tool = makeTool();
    const result = await installer.install(tool);

    expect(result.success).toBe(true);
    // readFileSync should NOT have been called for checksum purposes
    // (it may be called for other fs operations but not with a package.json path)
    const checksumCalls = readFileSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('package.json'),
    );
    expect(checksumCalls).toHaveLength(0);
  });

  // ── Install lock / serialization ────────────────────────────────────────────

  it('serializes concurrent installs of the same package', async () => {
    const tool = makeTool();
    const order: number[] = [];

    let firstInstallUnblock!: () => void;
    const firstInstallBlock = new Promise<void>((resolve) => {
      firstInstallUnblock = resolve;
    });

    jest
      .spyOn(installer as unknown as TestableInstaller, 'npmInstall')
      .mockImplementationOnce(async () => {
        await firstInstallBlock; // Hold the first install until we unblock
        order.push(1);
        return MOCK_INSTALL_PATH;
      })
      .mockImplementationOnce(async () => {
        order.push(2);
        return MOCK_INSTALL_PATH;
      });

    const first = installer.install(tool);
    // Give the first install time to acquire the lock before starting second.
    await new Promise<void>((r) => setTimeout(r, 20));

    const second = installer.install({ ...tool, id: 'tool-test-id-2' });

    // Unblock the first install; second should then run
    firstInstallUnblock();
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
  });

  // ── Event / audit completeness ──────────────────────────────────────────────

  it('emits all expected events in the correct order for a successful install', async () => {
    const tool = makeTool();
    const events: string[] = [];

    for (const evt of [
      'install:start',
      'install:download',
      'install:verify',
      'install:extract',
      'install:register',
      'install:complete',
    ] as const) {
      installer.on(evt, () => events.push(evt));
    }

    await installer.install(tool);

    expect(events).toEqual([
      'install:start',
      'install:download',
      'install:verify',
      'install:extract',
      'install:register',
      'install:complete',
    ]);
  });
});
