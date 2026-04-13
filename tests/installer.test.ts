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
});
