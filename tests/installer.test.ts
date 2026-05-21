jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn() },
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: { evaluate: jest.fn(() => ({ allowed: true, requiresApproval: false, reasons: [] })) },
}));

jest.mock('../src/policy/trust-evaluator', () => ({
  trustEvaluator: {
    evaluate: jest.fn(() => ({ score: 100, level: 'high' })),
    getMinimumRequired: jest.fn(() => 50),
  },
}));

jest.mock('../src/policy/approval-gates', () => ({
  approvalGate: { request: jest.fn(async () => undefined) },
}));

import type { ToolMetadata } from '../src/discovery/types';
import { DryRunExecutor } from '../src/provisioning/DryRunExecutor';
import { HotReloader } from '../src/provisioning/HotReloader';
import { Installer } from '../src/provisioning/installer';
import type { VerificationSummary } from '../src/provisioning/SignatureVerifier';
import type { IsolationStrategy } from '../src/provisioning/sandbox/Sandbox';

describe('Installer', () => {
  const tool: ToolMetadata = {
    id: 'secure-tool',
    name: 'secure-tool',
    version: '1.0.0',
    description: 'secure tool',
    source: 'official',
    capabilities: ['serve'],
    tags: ['test'],
    metadata: { packageName: 'secure-tool' },
  };

  function createSandbox(kind: 'docker' | 'wasm' = 'docker'): IsolationStrategy {
    return {
      kind,
      isAvailable: jest.fn(async () => true),
      provision: jest.fn(async (spec) => ({ id: `${kind}-handle`, kind, spec, metadata: {} })),
      start: jest.fn(async (handle) => ({ ...handle, startedAt: new Date() })),
      stop: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      inspect: jest.fn(async () => ({ healthy: true })),
      execute: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 10 })),
    };
  }

  it('rejects installs with bad package signatures before any install is executed', async () => {
    const dockerSandbox = createSandbox();
    const verifier = {
      verifyTool: jest.fn(async (): Promise<VerificationSummary> => ({
        verified: false,
        reason: 'bad signature',
        packages: [
          {
            name: 'secure-tool',
            requestedVersion: '1.0.0',
            resolvedVersion: '1.0.0',
            spec: 'secure-tool@1.0.0',
            manager: 'npm',
            verified: false,
            reason: 'bad signature',
            metadata: {},
          },
        ],
      })),
    };

    const installer = new Installer({
      verifier: verifier as never,
      dockerSandbox,
      runtimeRegistrar: { register: jest.fn(), list: jest.fn(() => []), get: jest.fn(), unregister: jest.fn() },
      dependencyResolver: { resolve: jest.fn(() => ({ packages: ['secure-tool@1.0.0'], conflicts: [], installOrder: ['secure-tool@1.0.0'] })) },
      configGenerator: { generate: jest.fn(() => ({ env: {}, args: [], workingDir: '/tmp', timeout: 1000 })) },
    });

    const result = await installer.install(tool);

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad signature');
    expect(dockerSandbox.execute).not.toHaveBeenCalled();
    expect(dockerSandbox.provision).not.toHaveBeenCalled();
  });

  it('supports dry-run mode without provisioning or installing packages', async () => {
    const dockerSandbox = createSandbox();
    const verification: VerificationSummary = {
      verified: true,
      packages: [
        {
          name: 'secure-tool',
          requestedVersion: '1.0.0',
          resolvedVersion: '1.0.0',
          spec: 'secure-tool@1.0.0',
          manager: 'npm',
          verified: true,
          method: 'npm-provenance',
          metadata: {},
        },
      ],
    };

    const installer = new Installer({
      verifier: { verifyTool: jest.fn(async () => verification) } as never,
      dockerSandbox,
      runtimeRegistrar: { register: jest.fn(), list: jest.fn(() => []), get: jest.fn(), unregister: jest.fn() },
      dependencyResolver: { resolve: jest.fn(() => ({ packages: ['secure-tool@1.0.0'], conflicts: [], installOrder: ['secure-tool@1.0.0'] })) },
      configGenerator: { generate: jest.fn(() => ({ env: {}, args: [], workingDir: '/tmp', timeout: 1000 })) },
      dryRunExecutor: new DryRunExecutor({ verifyTool: jest.fn(async () => verification) } as never, {
        resolve: jest.fn(() => ({ packages: ['secure-tool@1.0.0'], conflicts: [], installOrder: ['secure-tool@1.0.0'] })),
      } as never),
    });

    const result = await installer.install(tool, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(dockerSandbox.execute).not.toHaveBeenCalled();
    expect(dockerSandbox.provision).not.toHaveBeenCalled();
  });

  it('starts provisioned servers in the docker sandbox by default', async () => {
    const dockerSandbox = createSandbox('docker');
    const runtimeRegistrar = { register: jest.fn(), list: jest.fn(() => []), get: jest.fn(), unregister: jest.fn() };
    const hotReloader = new HotReloader(runtimeRegistrar as never);
    const verification: VerificationSummary = {
      verified: true,
      packages: [
        {
          name: 'secure-tool',
          requestedVersion: '1.0.0',
          resolvedVersion: '1.0.0',
          spec: 'secure-tool@1.0.0',
          manager: 'npm',
          verified: true,
          method: 'npm-provenance',
          metadata: {},
        },
      ],
    };

    const installer = new Installer({
      verifier: { verifyTool: jest.fn(async () => verification) } as never,
      dockerSandbox,
      runtimeRegistrar,
      hotReloader,
      dependencyResolver: { resolve: jest.fn(() => ({ packages: ['secure-tool@1.0.0'], conflicts: [], installOrder: ['secure-tool@1.0.0'] })) },
      configGenerator: { generate: jest.fn(() => ({ env: {}, args: [], workingDir: '/tmp', timeout: 1000 })) },
    });

    const result = await installer.install(tool);

    expect(result.success).toBe(true);
    expect(result.sandbox?.kind).toBe('docker');
    expect(dockerSandbox.execute).toHaveBeenCalled();
    expect(dockerSandbox.provision).toHaveBeenCalled();
  });

  it('preserves quoted runtime arguments while only containerizing path-like values', async () => {
    const dockerSandbox = createSandbox('docker');
    const runtimeRegistrar = { register: jest.fn(), list: jest.fn(() => []), get: jest.fn(), unregister: jest.fn() };
    const hotReloader = new HotReloader(runtimeRegistrar as never);
    const verification: VerificationSummary = {
      verified: true,
      packages: [
        {
          name: 'secure-tool',
          requestedVersion: '1.0.0',
          resolvedVersion: '1.0.0',
          spec: 'secure-tool@1.0.0',
          manager: 'npm',
          verified: true,
          method: 'npm-provenance',
          metadata: {},
        },
      ],
    };

    const quotedTool: ToolMetadata = {
      ...tool,
      metadata: {
        packageName: 'secure-tool',
        runtimeCommand: 'node "./server path.js" --mode "safe mode"',
      },
    };

    const installer = new Installer({
      verifier: { verifyTool: jest.fn(async () => verification) } as never,
      dockerSandbox,
      runtimeRegistrar,
      hotReloader,
      dependencyResolver: { resolve: jest.fn(() => ({ packages: ['secure-tool@1.0.0'], conflicts: [], installOrder: ['secure-tool@1.0.0'] })) },
      configGenerator: { generate: jest.fn(() => ({ env: {}, args: [], workingDir: '/tmp', timeout: 1000 })) },
    });

    const result = await installer.install(quotedTool);

    expect(result.success).toBe(true);
    expect(dockerSandbox.provision).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        cmd: 'node',
        args: expect.arrayContaining(['/workspace/server path.js', '--mode', 'safe mode']),
      }),
    }));
  });
});
