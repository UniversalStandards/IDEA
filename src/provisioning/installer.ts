import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLog } from '../security/audit';
import { config } from '../config';
import { policyEngine } from '../policy/policy-engine';
import { trustEvaluator } from '../policy/trust-evaluator';
import { approvalGate } from '../policy/approval-gates';
import type { ToolMetadata } from '../discovery/types';
import { dependencyResolver, type DependencyResolver } from './dependency-resolver';
import { configGenerator, type ConfigGenerator } from './config-generator';
import { runtimeRegistrar, type RegisteredTool, type RuntimeRegistrar } from './runtime-registrar';
import { DryRunExecutor } from './DryRunExecutor';
import { HotReloader } from './HotReloader';
import { signatureVerifier, type SignatureVerifier, type VerificationSummary } from './SignatureVerifier';
import { versionManager, type VersionManager, type VersionRecord } from './VersionManager';
import { DockerSandbox } from './sandbox/DockerSandbox';
import { WasmSandbox } from './sandbox/WasmSandbox';
import type { IsolationStrategy, SandboxCommand, SandboxHandle, SandboxSpec } from './sandbox/Sandbox';

const logger = createLogger('installer');
const INSTALL_BASE_DIR = path.resolve(process.cwd(), '.mcp', 'installed');
const INSTALL_LOCK_DIR = path.resolve(INSTALL_BASE_DIR, '.locks');

export interface InstallOptions {
  dryRun?: boolean;
  drainTimeoutMs?: number;
  allowWasmFallback?: boolean;
}

export interface InstallResult {
  success: boolean;
  tool: ToolMetadata;
  installedAt: Date;
  path?: string;
  error?: string;
  dryRun?: boolean;
  version?: string;
  verification?: VerificationSummary;
  dependencyTree?: string[];
  sandbox?: {
    kind: 'docker' | 'wasm';
    id: string;
  };
  rollbackVersion?: string;
}

interface InstallerDependencies {
  verifier?: SignatureVerifier;
  versionManager?: VersionManager;
  runtimeRegistrar?: Pick<RuntimeRegistrar, 'register' | 'list' | 'get' | 'unregister'>;
  dependencyResolver?: Pick<DependencyResolver, 'resolve'>;
  configGenerator?: Pick<ConfigGenerator, 'generate'>;
  dockerSandbox?: IsolationStrategy;
  wasmSandbox?: IsolationStrategy;
  hotReloader?: HotReloader;
  dryRunExecutor?: DryRunExecutor;
}

class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
      return;
    }
    this.permits += 1;
  }
}

function mapToolSourceForTrust(
  source: ToolMetadata['source'],
): 'official_registry' | 'github' | 'enterprise' | 'local' | 'unknown' {
  if (source === 'official') {
    return 'official_registry';
  }
  return source;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

export class Installer extends EventEmitter {
  private readonly semaphore: Semaphore;
  private readonly installed: Map<string, InstallResult> = new Map();
  private readonly verifier: SignatureVerifier;
  private readonly versionManager: VersionManager;
  private readonly runtimeRegistrar: Pick<RuntimeRegistrar, 'register' | 'list' | 'get' | 'unregister'>;
  private readonly dependencyResolver: Pick<DependencyResolver, 'resolve'>;
  private readonly configGenerator: Pick<ConfigGenerator, 'generate'>;
  private readonly dockerSandbox: IsolationStrategy;
  private readonly wasmSandbox: IsolationStrategy;
  private readonly hotReloader: HotReloader;
  private readonly dryRunExecutor: DryRunExecutor;

  constructor(dependencies: InstallerDependencies = {}) {
    super();

    const maxConcurrent = (() : number => {
      try {
        return config.MAX_CONCURRENT_INSTALLS;
      } catch {
        return parseInt(process.env['MAX_CONCURRENT_INSTALLS'] ?? '5', 10);
      }
    })();

    this.semaphore = new Semaphore(maxConcurrent);
    this.verifier = dependencies.verifier ?? signatureVerifier;
    this.versionManager = dependencies.versionManager ?? versionManager;
    this.runtimeRegistrar = dependencies.runtimeRegistrar ?? runtimeRegistrar;
    this.dependencyResolver = dependencies.dependencyResolver ?? dependencyResolver;
    this.configGenerator = dependencies.configGenerator ?? configGenerator;
    this.dockerSandbox = dependencies.dockerSandbox ?? new DockerSandbox();
    this.wasmSandbox = dependencies.wasmSandbox ?? new WasmSandbox();
    this.hotReloader = dependencies.hotReloader ?? new HotReloader(runtimeRegistrar);
    this.dryRunExecutor =
      dependencies.dryRunExecutor ?? new DryRunExecutor(this.verifier, dependencyResolver);

    fs.mkdirSync(INSTALL_BASE_DIR, { recursive: true });
    fs.mkdirSync(INSTALL_LOCK_DIR, { recursive: true });
  }

  async install(tool: ToolMetadata, options: InstallOptions = {}): Promise<InstallResult> {
    const start = Date.now();
    logger.info('Install requested', { toolId: tool.id, name: tool.name, version: tool.version });
    this.emit('installing', tool);

    await this.semaphore.acquire();
    const releaseLock = await this.acquireInstallLock(tool.id);

    let stagedVersion: VersionRecord | undefined;
    let sandbox: IsolationStrategy | undefined;
    let nextHandle: SandboxHandle | undefined;

    try {
      const policyCtx = {
        toolId: tool.id,
        actor: 'system:installer',
        action: options.dryRun ? 'install:dry-run' : 'install',
        environment: process.env['NODE_ENV'] ?? 'development',
        metadata: { source: tool.source, version: tool.version },
      };

      const decision = policyEngine.evaluate(policyCtx);
      if (!decision.allowed && !decision.requiresApproval) {
        return this.fail(tool, `Policy denied installation: ${decision.reasons.join('; ')}`, start);
      }

      const trustInput = {
        id: tool.id,
        name: tool.name,
        version: tool.version,
        source: mapToolSourceForTrust(tool.source),
        ...(tool.verified !== undefined ? { signatureValid: tool.verified } : {}),
        ...(tool.downloadCount !== undefined ? { downloadCount: tool.downloadCount } : {}),
        ...(tool.author ? { author: tool.author } : {}),
        ...(tool.metadata ? { metadata: tool.metadata } : {}),
      };
      const trustScore = trustEvaluator.evaluate(trustInput);
      const minRequired = trustEvaluator.getMinimumRequired('install');

      if (trustScore.score < minRequired && !decision.requiresApproval) {
        return this.fail(
          tool,
          `Trust score ${trustScore.score} below minimum ${minRequired} for installation`,
          start,
        );
      }

      if (decision.requiresApproval || trustScore.score < minRequired) {
        await approvalGate.request(
          tool.id,
          'install',
          'system:installer',
          `Install tool ${tool.name}@${tool.version} (trust: ${trustScore.score}, level: ${trustScore.level})`,
          { trustScore, policyReasons: decision.reasons },
        );
      }

      const resolved = this.dependencyResolver.resolve(tool);
      const verification = await this.verifier.verifyTool(tool, resolved.installOrder);
      if (!verification.verified) {
        return this.fail(tool, verification.reason ?? 'Signature verification failed', start, verification);
      }

      const installDir = this.versionManager.prepareInstallDir(tool.id, tool.version);
      const runtimeCommand = this.resolveRuntimeCommand(tool);
      const sandboxSpec = this.buildRuntimeSandboxSpec(tool, installDir, runtimeCommand);

      if (options.dryRun) {
        const dryRun = await this.dryRunExecutor.execute(tool, INSTALL_BASE_DIR, sandboxSpec);
        return this.success(tool, installDir, start, verification, dryRun.dependencies, {
          dryRun: true,
          version: tool.version,
        });
      }

      sandbox = await this.selectSandbox(tool, options.allowWasmFallback ?? false);
      stagedVersion = this.versionManager.stageVersion(tool.id, tool.version, installDir, {
        tool,
        sandboxKind: sandbox.kind,
        sandboxSpec,
      });

      await this.prepareInstallDirectory(tool, installDir);
      await this.installPackages(tool, verification, installDir, sandbox);

      const runtimeConfig = this.configGenerator.generate(tool, {});
      nextHandle = await sandbox.provision({
        ...sandboxSpec,
        command: this.containerizeCommand(runtimeCommand, installDir),
      });

      const installedTool = { ...tool, entryPoint: tool.entryPoint ?? installDir };
      const previousHandle = this.hotReloader.getActiveHandle(tool.id);
      const reloadResult = await this.hotReloader.reload({
        tool: installedTool,
        config: runtimeConfig,
        sandbox,
        nextHandle,
        ...(previousHandle ? { previousHandle } : {}),
        ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
      });

      this.versionManager.activateVersion(tool.id, tool.version, {
        runtimeConfig,
        sandboxHandle: reloadResult.activeHandle,
      });

      const result = this.success(
        installedTool,
        installDir,
        start,
        verification,
        verification.packages.map((entry) => entry.spec),
        {
          version: tool.version,
          sandbox: {
            kind: reloadResult.activeHandle.kind,
            id: reloadResult.activeHandle.id,
          },
        },
      );

      this.installed.set(tool.id, result);
      this.emit('installed', result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (nextHandle && sandbox) {
        await sandbox.stop(nextHandle).catch(() => undefined);
        await sandbox.remove(nextHandle).catch(() => undefined);
      }
      if (stagedVersion) {
        this.versionManager.markFailed(tool.id, stagedVersion.version, message);
      }
      if (stagedVersion?.installPath) {
        fs.rmSync(stagedVersion.installPath, { recursive: true, force: true });
      }

      const rollbackTarget = this.versionManager.getActiveVersion(tool.id);
      return this.fail(tool, message, start, undefined, rollbackTarget?.version);
    } finally {
      releaseLock();
      this.semaphore.release();
    }
  }

  async rollback(toolId: string, version?: string): Promise<InstallResult> {
    const installed = this.installed.get(toolId) ?? this.installed.get(toolId);
    const currentTool = installed?.tool ?? this.runtimeRegistrar.get(toolId)?.tool;
    if (!currentTool) {
      throw new Error(`Tool not installed: ${toolId}`);
    }

    const target = this.versionManager.rollback(toolId, version);
    const sandboxMetadata = target.metadata['sandboxSpec'];
    if (typeof sandboxMetadata !== 'object' || sandboxMetadata === null) {
      throw new Error(`Rollback metadata missing sandbox spec for ${toolId}@${target.version}`);
    }

    const sandbox = target.metadata['sandboxKind'] === 'wasm' ? this.wasmSandbox : this.dockerSandbox;
    const handle = await sandbox.provision(sandboxMetadata as SandboxSpec);
    const runtimeConfig = this.configGenerator.generate(currentTool, {});
    const rolledTool = { ...currentTool, version: target.version };
    const previousHandle = this.hotReloader.getActiveHandle(toolId);

    const swap = await this.hotReloader.reload({
      tool: rolledTool,
      config: runtimeConfig,
      sandbox,
      nextHandle: handle,
      ...(previousHandle ? { previousHandle } : {}),
    });

    const result: InstallResult = {
      success: true,
      tool: rolledTool,
      installedAt: new Date(),
      path: target.installPath,
      version: target.version,
      sandbox: { kind: swap.activeHandle.kind, id: swap.activeHandle.id },
      rollbackVersion: target.version,
    };

    this.installed.set(toolId, result);
    return result;
  }

  async uninstall(toolId: string): Promise<void> {
    const installResult = this.installed.get(toolId);
    if (!installResult) {
      throw new Error(`Tool not installed: ${toolId}`);
    }

    const activeHandle = this.hotReloader.getActiveHandle(toolId);
    if (activeHandle) {
      const sandbox = activeHandle.kind === 'docker' ? this.dockerSandbox : this.wasmSandbox;
      await sandbox.stop(activeHandle).catch(() => undefined);
      await sandbox.remove(activeHandle).catch(() => undefined);
      this.hotReloader.clearActiveHandle(toolId);
    }

    this.runtimeRegistrar.unregister(toolId);
    const installDir = path.resolve(INSTALL_BASE_DIR, toolId);
    fs.rmSync(installDir, { recursive: true, force: true });
    this.installed.delete(toolId);

    auditLog.record('tool.uninstall', 'system:installer', toolId, 'success', undefined, {
      removedPath: installDir,
    });

    metrics.increment('tools_uninstalled_total');
    this.emit('uninstalled', toolId);
  }

  isInstalled(toolId: string): boolean {
    return this.installed.has(toolId);
  }

  listInstalled(): RegisteredTool[] {
    return this.runtimeRegistrar.list().filter((entry) => this.installed.has(entry.tool.id));
  }

  getInstallResult(toolId: string): InstallResult | undefined {
    return this.installed.get(toolId);
  }

  private async installPackages(
    tool: ToolMetadata,
    verification: VerificationSummary,
    installDir: string,
    sandbox: IsolationStrategy,
  ): Promise<void> {
    const manager = tool.metadata?.['packageManager'] === 'pip' ? 'pip' : 'npm';
    const specs = verification.packages.map((entry) => entry.spec);

    if (manager === 'pip') {
      const result = await sandbox.execute(
        {
          toolId: `${tool.id}-install`,
          version: tool.version,
          capabilityDir: installDir,
          image: 'python:3.12-alpine',
          command: {
            cmd: 'pip',
            args: ['install', '--no-cache-dir', ...specs],
            cwd: '/workspace',
          },
          allowedEndpoints: [],
          readOnlyRootFs: false,
        },
      );

      if (result.exitCode !== 0) {
        throw new Error(`pip install failed for ${tool.id}: ${result.stderr || result.stdout}`);
      }
      return;
    }

    const result = await sandbox.execute(
      {
        toolId: `${tool.id}-install`,
        version: tool.version,
        capabilityDir: installDir,
        image: 'node:20-alpine',
        command: {
          cmd: 'npm',
          args: ['install', '--save', '--no-audit', '--no-fund', '--ignore-scripts=false', ...specs],
          cwd: '/workspace',
        },
        allowedEndpoints: [],
        readOnlyRootFs: false,
      },
    );

    if (result.exitCode !== 0) {
      throw new Error(`npm install failed for ${tool.id}: ${result.stderr || result.stdout}`);
    }
  }

  private async selectSandbox(tool: ToolMetadata, allowWasmFallback: boolean): Promise<IsolationStrategy> {
    if (await this.dockerSandbox.isAvailable()) {
      return this.dockerSandbox;
    }

    const metadataPrefersWasm = tool.metadata?.['sandbox'] === 'wasm' || tool.entryPoint?.endsWith('.wasm');
    if (allowWasmFallback || metadataPrefersWasm) {
      return this.wasmSandbox;
    }

    throw new Error('Docker sandbox is unavailable and no fallback is permitted');
  }

  private buildRuntimeSandboxSpec(
    tool: ToolMetadata,
    installDir: string,
    runtimeCommand: SandboxCommand,
  ): SandboxSpec {
    return {
      toolId: tool.id,
      version: tool.version,
      capabilityDir: installDir,
      command: this.containerizeCommand(runtimeCommand, installDir),
      allowedEndpoints: this.readAllowedEndpoints(tool),
      labels: {
        'idea.tool_name': tool.name,
      },
      image: tool.metadata?.['packageManager'] === 'pip' ? 'python:3.12-alpine' : 'node:20-alpine',
      readOnlyRootFs: true,
      resourceLimits: {
        memoryMb: this.readNumber(tool.metadata?.['memoryMb'], 512),
        nanoCpus: this.readNumber(tool.metadata?.['nanoCpus'], 1_000_000_000),
        pidsLimit: this.readNumber(tool.metadata?.['pidsLimit'], 128),
      },
    };
  }

  private containerizeCommand(command: SandboxCommand, installDir: string): SandboxCommand {
    const cwd = command.cwd ? this.resolveContainerPath(command.cwd, installDir) : '/workspace';
    return {
      ...command,
      cwd,
      args: command.args.map((arg) => this.resolveContainerPath(arg, installDir)),
    };
  }

  private resolveContainerPath(value: string, installDir: string): string {
    if (!value) {
      return value;
    }
    if (path.isAbsolute(value) && value.startsWith(installDir)) {
      const relative = path.relative(installDir, value);
      return relative ? path.posix.join('/workspace', relative) : '/workspace';
    }
    if (!path.isAbsolute(value) && (value.startsWith('./') || value.startsWith('../') || value.endsWith('.js') || value.endsWith('.mjs') || value.endsWith('.cjs') || value.endsWith('.py') || value.endsWith('.wasm'))) {
      return path.posix.join('/workspace', value.replace(/\\/g, '/'));
    }
    return value;
  }

  private resolveRuntimeCommand(tool: ToolMetadata): SandboxCommand {
    const metadataCommand = tool.metadata?.['runtimeCommand'];
    if (typeof metadataCommand === 'string' && metadataCommand.trim()) {
      return this.parseCommand(metadataCommand);
    }

    if (tool.installCommand) {
      return this.parseCommand(tool.installCommand);
    }

    if (tool.entryPoint) {
      const runtime = tool.entryPoint.endsWith('.py') ? 'python' : tool.entryPoint.endsWith('.wasm') ? tool.entryPoint : 'node';
      const args = tool.entryPoint.endsWith('.wasm') ? [] : [tool.entryPoint];
      return { cmd: runtime, args };
    }

    const metaCommand = tool.metadata?.['command'];
    if (typeof metaCommand === 'string' && metaCommand.trim()) {
      return this.parseCommand(metaCommand);
    }

    return {
      cmd: 'npx',
      args: ['--yes', this.primaryPackageName(tool)],
    };
  }

  private parseCommand(command: string): SandboxCommand {
    const parts = command.trim().split(/\s+/);
    const cmd = parts.shift();
    if (!cmd) {
      throw new Error('Runtime command is empty');
    }
    return { cmd, args: parts };
  }

  private primaryPackageName(tool: ToolMetadata): string {
    const packageName = tool.metadata?.['packageName'];
    return typeof packageName === 'string' && packageName.length > 0 ? packageName : tool.name;
  }

  private readAllowedEndpoints(tool: ToolMetadata): string[] {
    const endpoints = tool.metadata?.['allowedEndpoints'];
    if (!Array.isArray(endpoints)) {
      return [];
    }
    return endpoints.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private async prepareInstallDirectory(tool: ToolMetadata, installDir: string): Promise<void> {
    fs.mkdirSync(installDir, { recursive: true });

    const packageManager = tool.metadata?.['packageManager'] === 'pip' ? 'pip' : 'npm';
    if (packageManager === 'pip') {
      const requirementsPath = path.join(installDir, 'requirements.txt');
      if (!fs.existsSync(requirementsPath)) {
        fs.writeFileSync(requirementsPath, '', 'utf8');
      }
      return;
    }

    const packageJsonPath = path.join(installDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(
          {
            name: `mcp-install-${sanitizeName(tool.name)}`,
            version: tool.version,
            private: true,
          },
          null,
          2,
        ),
        'utf8',
      );
    }
  }

  private async acquireInstallLock(toolId: string): Promise<() => void> {
    const lockPath = path.resolve(INSTALL_LOCK_DIR, `${sanitizeName(toolId)}.lock`);

    for (;;) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        return () => {
          fs.closeSync(fd);
          fs.rmSync(lockPath, { force: true });
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('EEXIST')) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          timer.unref();
        });
      }
    }
  }

  private success(
    tool: ToolMetadata,
    installPath: string,
    startMs: number,
    verification: VerificationSummary | undefined,
    dependencyTree: string[],
    overrides: Partial<InstallResult> = {},
  ): InstallResult {
    const result: InstallResult = {
      success: true,
      tool,
      installedAt: new Date(),
      path: installPath,
      dependencyTree,
      ...(verification ? { verification } : {}),
      ...overrides,
    };

    metrics.increment('tools_installed_total', { source: tool.source });
    metrics.histogram('tool_install_duration_ms', Date.now() - startMs);
    auditLog.record('tool.install', 'system:installer', tool.id, 'success', undefined, {
      installPath,
      durationMs: Date.now() - startMs,
      version: tool.version,
      dryRun: result.dryRun ?? false,
    });

    return result;
  }

  private fail(
    tool: ToolMetadata,
    error: string,
    startMs: number,
    verification?: VerificationSummary,
    rollbackVersion?: string,
  ): InstallResult {
    const result: InstallResult = {
      success: false,
      tool,
      installedAt: new Date(),
      error,
      ...(verification ? { verification } : {}),
      ...(rollbackVersion ? { rollbackVersion } : {}),
    };

    auditLog.record('tool.install', 'system:installer', tool.id, 'failure', undefined, {
      error,
      durationMs: Date.now() - startMs,
      rollbackVersion,
    });

    metrics.increment('tools_install_failures_total', { source: tool.source });
    this.emit('failed', result);
    logger.error('Tool installation failed', { toolId: tool.id, error, rollbackVersion });

    return result;
  }
}

export const installer = new Installer();
