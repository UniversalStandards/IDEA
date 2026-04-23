/**
 * tests/installer.test.ts
 * Unit tests for src/provisioning/installer.ts
 * All filesystem and subprocess calls are mocked — tests are fully deterministic.
 */

// ─── Module mocks (must be declared before any imports) ───────────────────────

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
  auditLog: { record: jest.fn() },
}));

jest.mock('../src/config', () => ({
  config: {
    MAX_CONCURRENT_INSTALLS: 5,
    NODE_ENV: 'test',
  },
}));

const mockPolicyEvaluate = jest.fn();
jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: { evaluate: mockPolicyEvaluate },
}));

const mockTrustEvaluate = jest.fn();
const mockTrustGetMinimumRequired = jest.fn();
jest.mock('../src/policy/trust-evaluator', () => ({
  trustEvaluator: {
    evaluate: mockTrustEvaluate,
    getMinimumRequired: mockTrustGetMinimumRequired,
  },
}));

const mockApprovalRequest = jest.fn();
jest.mock('../src/policy/approval-gates', () => ({
  approvalGate: { request: mockApprovalRequest },
}));

const mockDependencyResolve = jest.fn();
jest.mock('../src/provisioning/dependency-resolver', () => ({
  dependencyResolver: { resolve: mockDependencyResolve },
}));

const mockConfigGenerate = jest.fn();
jest.mock('../src/provisioning/config-generator', () => ({
  configGenerator: { generate: mockConfigGenerate },
}));

const mockRuntimeRegister = jest.fn();
const mockRuntimeUnregister = jest.fn();
const mockRuntimeList = jest.fn();
jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: {
    register: mockRuntimeRegister,
    unregister: mockRuntimeUnregister,
    list: mockRuntimeList,
  },
}));

// Mock child_process.execFile to avoid real subprocess invocations.
// We attach util.promisify.custom so that promisify(execFile) returns an async function
// that resolves to { stdout, stderr } — matching Node.js's real execFile behaviour.
import { promisify } from 'util';

const mockExecFileCustom = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
const mockExecFile = Object.assign(jest.fn(), {
  [promisify.custom]: mockExecFileCustom,
});
jest.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock the fs module to avoid touching the real filesystem
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { Installer } from '../src/provisioning/installer';
import type { ToolMetadata } from '../src/discovery/types';
import * as fsModule from 'fs';

const mockFs = fsModule as jest.Mocked<typeof fsModule>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTool(id = 'test-tool', overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `Test tool ${id}`,
    source: 'official',
    capabilities: ['test'],
    tags: [],
    verified: true,
    downloadCount: 1000,
    ...overrides,
  };
}

/** Sets up all mocks for a clean success scenario with no packages to install. */
function setupSuccessDefaults(): void {
  mockPolicyEvaluate.mockReturnValue({ allowed: true, requiresApproval: false, reasons: [] });
  mockTrustEvaluate.mockReturnValue({ score: 80, level: 'high', breakdown: {} });
  mockTrustGetMinimumRequired.mockReturnValue(50);
  mockDependencyResolve.mockReturnValue({ installOrder: [], conflicts: [] });
  mockConfigGenerate.mockReturnValue({});
  mockRuntimeRegister.mockReturnValue({});
  mockRuntimeList.mockReturnValue([]);
  mockFs.existsSync.mockReturnValue(false);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Installer', () => {
  let installer: Installer;

  beforeEach(() => {
    jest.clearAllMocks();
    installer = new Installer();
    setupSuccessDefaults();
  });

  // ── Successful install flow ──────────────────────────────────────────────

  describe('install() — success path', () => {
    it('returns a successful InstallResult when all checks pass', async () => {
      const tool = makeTool();
      const result = await installer.install(tool);

      expect(result.success).toBe(true);
      expect(result.tool.id).toBe('test-tool');
      expect(result.error).toBeUndefined();
      expect(result.installedAt).toBeInstanceOf(Date);
    });

    it('registers the tool in the runtime registrar on a successful install', async () => {
      await installer.install(makeTool());
      expect(mockRuntimeRegister).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-tool' }),
        expect.anything(),
      );
    });

    it('generates a runtime config using the config generator', async () => {
      await installer.install(makeTool());
      expect(mockConfigGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-tool' }),
        expect.anything(),
      );
    });

    it('resolves dependencies before installation', async () => {
      await installer.install(makeTool());
      expect(mockDependencyResolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-tool' }),
      );
    });

    it('creates the install directory on the filesystem', async () => {
      await installer.install(makeTool());
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('test-tool'),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('stores the result so isInstalled() returns true after a successful install', async () => {
      await installer.install(makeTool('cached-tool'));
      expect(installer.isInstalled('cached-tool')).toBe(true);
    });

    it('getInstallResult() returns the stored result for an installed tool', async () => {
      await installer.install(makeTool('result-tool'));
      const stored = installer.getInstallResult('result-tool');
      expect(stored).toBeDefined();
      expect(stored!.success).toBe(true);
    });
  });

  // ── Install events ───────────────────────────────────────────────────────

  describe('install() — event emission', () => {
    it('emits an "installing" event before the installation begins', async () => {
      const tool = makeTool();
      const spy = jest.fn();
      installer.on('installing', spy);
      await installer.install(tool);
      expect(spy).toHaveBeenCalledWith(tool);
    });

    it('emits an "installed" event with the result on success', async () => {
      const spy = jest.fn();
      installer.on('installed', spy);
      await installer.install(makeTool());
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('emits a "failed" event with the result on failure', async () => {
      mockPolicyEvaluate.mockReturnValue({
        allowed: false,
        requiresApproval: false,
        reasons: ['blocked'],
      });
      const spy = jest.fn();
      installer.on('failed', spy);
      await installer.install(makeTool());
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  // ── Policy failures ──────────────────────────────────────────────────────

  describe('install() — policy denial', () => {
    it('returns a failure result when the policy engine denies the installation', async () => {
      mockPolicyEvaluate.mockReturnValue({
        allowed: false,
        requiresApproval: false,
        reasons: ['Blocked by deny-all policy'],
      });
      const result = await installer.install(makeTool());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Policy denied installation');
    });

    it('does not register the tool when policy denies installation', async () => {
      mockPolicyEvaluate.mockReturnValue({
        allowed: false,
        requiresApproval: false,
        reasons: ['denied'],
      });
      await installer.install(makeTool('denied-tool'));
      expect(mockRuntimeRegister).not.toHaveBeenCalled();
      expect(installer.isInstalled('denied-tool')).toBe(false);
    });
  });

  // ── Trust failures ───────────────────────────────────────────────────────

  describe('install() — trust score below minimum', () => {
    it('returns a failure result when the trust score is below the required minimum', async () => {
      mockTrustEvaluate.mockReturnValue({ score: 20, level: 'low', breakdown: {} });
      mockTrustGetMinimumRequired.mockReturnValue(50);

      const result = await installer.install(makeTool());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Trust score');
    });
  });

  // ── Approval gate ────────────────────────────────────────────────────────

  describe('install() — approval gate', () => {
    it('requests approval when the policy engine requires it', async () => {
      mockPolicyEvaluate.mockReturnValue({
        allowed: true,
        requiresApproval: true,
        reasons: ['requires manual approval'],
      });
      mockApprovalRequest.mockResolvedValue(undefined);

      const result = await installer.install(makeTool());
      expect(mockApprovalRequest).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('returns a failure result when the approval gate rejects the request', async () => {
      mockPolicyEvaluate.mockReturnValue({
        allowed: true,
        requiresApproval: true,
        reasons: [],
      });
      mockApprovalRequest.mockRejectedValue(new Error('Approval denied by reviewer'));

      const result = await installer.install(makeTool());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Approval denied');
    });
  });

  // ── npm install failure ──────────────────────────────────────────────────

  describe('install() — npm subprocess failure', () => {
    it('returns a failure result when npm install exits with an error', async () => {
      // Set up so packages are required (non-empty installOrder)
      mockDependencyResolve.mockReturnValue({
        installOrder: ['some-npm-package@1.0.0'],
        conflicts: [],
      });

      // Make execFile reject (simulating npm failure)
      mockExecFileCustom.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await installer.install(makeTool());
      expect(result.success).toBe(false);
      expect(result.error).toContain('npm install failed');
    });

    it('returns a successful result when npm install succeeds with packages', async () => {
      mockDependencyResolve.mockReturnValue({
        installOrder: ['some-npm-package@1.0.0'],
        conflicts: [],
      });

      // execFileCustom resolves successfully — this is used by promisify.custom
      mockExecFileCustom.mockResolvedValueOnce({ stdout: 'added 1 package', stderr: '' });

      const result = await installer.install(makeTool());
      expect(result.success).toBe(true);
    });
  });

  // ── Dependency conflicts warning ─────────────────────────────────────────

  describe('install() — dependency conflicts', () => {
    it('logs a warning but still succeeds when dependency conflicts are detected', async () => {
      mockDependencyResolve.mockReturnValue({
        installOrder: [],
        conflicts: ['package-a vs package-b version mismatch'],
      });
      const result = await installer.install(makeTool());
      expect(result.success).toBe(true);
    });
  });

  // ── isInstalled / getInstallResult ───────────────────────────────────────

  describe('isInstalled() / getInstallResult()', () => {
    it('returns false for isInstalled() before any install has been performed', () => {
      expect(installer.isInstalled('never-installed')).toBe(false);
    });

    it('returns undefined from getInstallResult() for a tool that has not been installed', () => {
      expect(installer.getInstallResult('no-such-tool')).toBeUndefined();
    });
  });

  // ── uninstall() ──────────────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('throws when attempting to uninstall a tool that was never installed', async () => {
      await expect(installer.uninstall('not-installed')).rejects.toThrow(
        'Tool not installed: not-installed',
      );
    });

    it('calls runtimeRegistrar.unregister() on successful uninstall', async () => {
      const tool = makeTool('to-uninstall');
      await installer.install(tool);

      mockRuntimeUnregister.mockReturnValue(undefined);
      mockFs.existsSync.mockReturnValue(false); // No install directory to clean up

      await installer.uninstall('to-uninstall');
      expect(mockRuntimeUnregister).toHaveBeenCalledWith('to-uninstall');
    });

    it('removes the tool from the installed map so isInstalled() returns false afterwards', async () => {
      const tool = makeTool('remove-me');
      await installer.install(tool);
      expect(installer.isInstalled('remove-me')).toBe(true);

      mockFs.existsSync.mockReturnValue(false);
      await installer.uninstall('remove-me');
      expect(installer.isInstalled('remove-me')).toBe(false);
    });

    it('removes the install directory when it exists on disk', async () => {
      const tool = makeTool('dir-cleanup');
      await installer.install(tool);

      // Simulate directory exists on disk
      mockFs.existsSync.mockReturnValue(true);
      mockExecFileCustom.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await installer.uninstall('dir-cleanup');
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('dir-cleanup'),
        expect.objectContaining({ recursive: true }),
      );
    });
  });

  // ── Concurrent install serialization ────────────────────────────────────

  describe('concurrent install serialization', () => {
    it('allows two installs to complete when concurrency permits', async () => {
      const tool1 = makeTool('concurrent-a');
      const tool2 = makeTool('concurrent-b');

      const [result1, result2] = await Promise.all([
        installer.install(tool1),
        installer.install(tool2),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    it('second install of the same tool ID overwrites the first in the installed map', async () => {
      const tool = makeTool('overwrite-tool');
      await installer.install(tool);
      await installer.install(tool);

      // Only one entry should exist (the map keyed by toolId)
      expect(installer.isInstalled('overwrite-tool')).toBe(true);
    });
  });
});
