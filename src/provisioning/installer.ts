import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLog } from '../security/audit';
import { config } from '../config';
import { policyEngine } from '../policy/policy-engine';
import { trustEvaluator } from '../policy/trust-evaluator';
import { approvalGate } from '../policy/approval-gates';
import type { ToolMetadata } from '../discovery/types';
import { dependencyResolver } from './dependency-resolver';
import { configGenerator } from './config-generator';
import { runtimeRegistrar, RegisteredTool } from './runtime-registrar';

const logger = createLogger('installer');
const execFileAsync = promisify(execFile);

/** Options accepted by {@link Installer.install}. */
export interface InstallOptions {
  /** When true, validate all steps without executing any filesystem writes. */
  dryRun?: boolean;
  /**
   * Expected SHA-256 hex digest of the installed package manifest
   * (`package.json` inside the install directory).  When provided the
   * installer will throw and rollback if the computed digest does not match.
   */
  expectedChecksum?: string;
}

/** Describes the steps that would be executed in a dry-run install. */
export interface DryRunPlan {
  dryRun: true;
  tool: ToolMetadata;
  steps: string[];
  packages: string[];
  installDir: string;
}

export interface InstallResult {
  success: boolean;
  tool: ToolMetadata;
  installedAt: Date;
  path?: string;
  error?: string;
  /** Populated when the install was requested with `dryRun: true`. */
  plan?: DryRunPlan;
}

const INSTALL_BASE_DIR = path.resolve(process.cwd(), '.mcp', 'installed');
const LOCKS_DIR = path.join(process.cwd(), 'runtime', 'locks');

// ─── File-system lock helpers ──────────────────────────────────────────────

function getLockFilePath(packageName: string): string {
  return path.join(LOCKS_DIR, `${packageName}.lock`);
}

function writeLockFile(packageName: string): void {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  fs.writeFileSync(
    getLockFilePath(packageName),
    JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), package: packageName }),
    'utf-8',
  );
}

function removeLockFile(packageName: string): void {
  try {
    fs.rmSync(getLockFilePath(packageName), { force: true });
  } catch {
    // Best-effort; ignore errors when cleaning up a lock file.
  }
}

class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

function mapToolSourceForTrust(
  source: ToolMetadata['source'],
): 'official_registry' | 'github' | 'enterprise' | 'local' | 'unknown' {
  if (source === 'official') return 'official_registry';
  return source;
}

export class Installer extends EventEmitter {
  private readonly semaphore: Semaphore;
  private readonly installed: Map<string, InstallResult> = new Map();
  /**
   * In-memory per-package lock for serializing concurrent installs of the
   * same package name.  The map value is the promise of the in-flight install;
   * a second caller awaits this promise before proceeding.
   */
  private readonly packageLocks: Map<string, Promise<void>> = new Map();

  constructor() {
    super();

    const maxConcurrent = (() => {
      try {
        return config.MAX_CONCURRENT_INSTALLS;
      } catch {
        return parseInt(process.env['MAX_CONCURRENT_INSTALLS'] ?? '5', 10);
      }
    })();

    this.semaphore = new Semaphore(maxConcurrent);
  }

  async install(tool: ToolMetadata, options: InstallOptions = {}): Promise<InstallResult> {
    const { dryRun = false } = options;
    const expectedChecksum =
      options.expectedChecksum ??
      (tool.metadata?.['checksumSha256'] as string | undefined);

    const correlationId = randomUUID();
    const start = Date.now();

    this.emit('install:start', { tool, dryRun, correlationId });
    auditLog.record('install.start', 'system:installer', tool.id, 'pending', correlationId, {
      dryRun,
    });
    logger.info('Install requested', { toolId: tool.id, name: tool.name, dryRun });

    // ── Serialize concurrent installs of the same package ─────────────────
    const existingLock = this.packageLocks.get(tool.name);
    if (existingLock) {
      logger.info('Waiting for in-flight install of the same package', {
        toolId: tool.id,
        name: tool.name,
      });
      await existingLock;
    }

    // Set up the per-package lock for this install run.
    // Initialize to a no-op so TypeScript is satisfied; the Promise executor
    // assigns the real resolver synchronously before it is ever called.
    let resolveLock: () => void = () => undefined;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.packageLocks.set(tool.name, lockPromise);

    await this.semaphore.acquire();

    const installDir = path.join(INSTALL_BASE_DIR, tool.name);
    // Track whether we have created filesystem artefacts that need rollback.
    let rollbackNeeded = false;

    try {
      // ── File-system lock (visible to external processes) ──────────────
      if (!dryRun) {
        writeLockFile(tool.name);
      }

      // Step 1: Policy check
      const policyCtx = {
        toolId: tool.id,
        actor: 'system:installer',
        action: 'install',
        environment: process.env['NODE_ENV'] ?? 'development',
        metadata: { source: tool.source, version: tool.version },
      };

      const decision = policyEngine.evaluate(policyCtx);

      if (!decision.allowed && !decision.requiresApproval) {
        const err = `Policy denied installation: ${decision.reasons.join('; ')}`;
        return this.fail(tool, err, start, correlationId);
      }

      // Step 2: Trust evaluation
      const trustInput = {
        id: tool.id,
        name: tool.name,
        version: tool.version,
        source: mapToolSourceForTrust(tool.source),
        ...(tool.verified !== undefined && { signatureValid: tool.verified }),
        ...(tool.downloadCount !== undefined && { downloadCount: tool.downloadCount }),
        ...(tool.author !== undefined && { author: tool.author }),
        ...(tool.metadata !== undefined && { metadata: tool.metadata }),
      };

      const trustScore = trustEvaluator.evaluate(trustInput);
      const minRequired = trustEvaluator.getMinimumRequired('install');

      logger.info('Trust evaluated', {
        toolId: tool.id,
        score: trustScore.score,
        level: trustScore.level,
        minRequired,
      });

      if (trustScore.score < minRequired && !decision.requiresApproval) {
        const err = `Trust score ${trustScore.score} below minimum ${minRequired} for installation`;
        return this.fail(tool, err, start, correlationId);
      }

      // Step 3: Approval gate if required
      if (decision.requiresApproval || trustScore.score < minRequired) {
        try {
          await approvalGate.request(
            tool.id,
            'install',
            'system:installer',
            `Install tool ${tool.name}@${tool.version} (trust: ${trustScore.score}, level: ${trustScore.level})`,
            { trustScore, policyReasons: decision.reasons },
          );
          logger.info('Install approved', { toolId: tool.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.fail(tool, `Approval denied or timed out: ${msg}`, start, correlationId);
        }
      }

      // Step 4: Dependency resolution
      const resolved = dependencyResolver.resolve(tool);

      if (resolved.conflicts.length > 0) {
        logger.warn('Dependency conflicts detected, proceeding with caution', {
          toolId: tool.id,
          conflicts: resolved.conflicts,
        });
      }

      // ── Short-circuit for dry-run ──────────────────────────────────────
      if (dryRun) {
        const plan: DryRunPlan = {
          dryRun: true,
          tool,
          steps: [
            'policy.check',
            'trust.evaluate',
            'dependency.resolve',
            'npm.install',
            'checksum.verify',
            'config.generate',
            'runtime.register',
          ],
          packages: resolved.installOrder,
          installDir,
        };

        const result: InstallResult = {
          success: true,
          tool,
          installedAt: new Date(),
          plan,
        };

        this.emit('install:complete', { tool, dryRun: true, plan, correlationId });
        auditLog.record('install.complete', 'system:installer', tool.id, 'success', correlationId, {
          dryRun: true,
        });
        logger.info('Dry-run complete', { toolId: tool.id, packages: plan.packages });
        return result;
      }

      // Step 5: Download / npm install ──────────────────────────────────
      this.emit('install:download', {
        tool,
        packages: resolved.installOrder,
        correlationId,
      });
      auditLog.record(
        'install.download',
        'system:installer',
        tool.id,
        'pending',
        correlationId,
        { packages: resolved.installOrder },
      );

      rollbackNeeded = true;
      const installPath = await this.npmInstall(tool, resolved.installOrder, installDir);

      // Step 5.5: Checksum verification ─────────────────────────────────
      this.emit('install:verify', { tool, installPath, correlationId });
      auditLog.record('install.verify', 'system:installer', tool.id, 'pending', correlationId);

      if (expectedChecksum) {
        const manifestPath = path.join(installPath, 'package.json');
        const content = fs.readFileSync(manifestPath);
        const computed = crypto.createHash('sha256').update(content).digest('hex');

        if (computed !== expectedChecksum) {
          throw new Error(
            `Checksum mismatch for ${tool.name}: expected ${expectedChecksum}, got ${computed}`,
          );
        }

        logger.info('Checksum verified', { toolId: tool.id, checksum: computed });
      }

      // Step 6: Config generation (extract phase) ───────────────────────
      this.emit('install:extract', { tool, installPath, correlationId });
      auditLog.record('install.extract', 'system:installer', tool.id, 'pending', correlationId);

      const runtimeConfig = configGenerator.generate(tool, {});

      // Step 7: Runtime registration ────────────────────────────────────
      this.emit('install:register', { tool, installPath, correlationId });
      auditLog.record('install.register', 'system:installer', tool.id, 'pending', correlationId);

      const installedTool = { ...tool, entryPoint: tool.entryPoint ?? installPath };
      runtimeRegistrar.register(installedTool, runtimeConfig);

      const result: InstallResult = {
        success: true,
        tool: installedTool,
        installedAt: new Date(),
        path: installPath,
      };

      this.installed.set(tool.id, result);
      metrics.increment('tools_installed_total', { source: tool.source });
      metrics.histogram('tool_install_duration_ms', Date.now() - start);

      auditLog.record(
        'tool.install',
        'system:installer',
        tool.id,
        'success',
        correlationId,
        { path: installPath, duration: Date.now() - start },
      );

      rollbackNeeded = false;
      this.emit('install:complete', { tool, result, correlationId });
      logger.info('Tool installed successfully', {
        toolId: tool.id,
        path: installPath,
        durationMs: Date.now() - start,
      });

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (rollbackNeeded) {
        await this.rollback(tool, installDir, correlationId);
      }

      return this.fail(tool, msg, start, correlationId);
    } finally {
      this.semaphore.release();
      if (!dryRun) {
        removeLockFile(tool.name);
      }
      this.packageLocks.delete(tool.name);
      resolveLock();
    }
  }

  async uninstall(toolId: string): Promise<void> {
    logger.info('Uninstall requested', { toolId });

    const installResult = this.installed.get(toolId);
    if (!installResult) {
      throw new Error(`Tool not installed: ${toolId}`);
    }

    runtimeRegistrar.unregister(toolId);

    const installDir = path.join(INSTALL_BASE_DIR, installResult.tool.name);
    if (fs.existsSync(installDir)) {
      try {
        await execFileAsync('npm', ['uninstall', installResult.tool.name], {
          cwd: installDir,
          timeout: 60_000,
        });
      } catch (err) {
        logger.warn('npm uninstall failed, removing directory anyway', {
          toolId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      fs.rmSync(installDir, { recursive: true, force: true });
    }

    this.installed.delete(toolId);

    auditLog.record('tool.uninstall', 'system:installer', toolId, 'success');

    metrics.increment('tools_uninstalled_total');
    this.emit('uninstalled', toolId);
    logger.info('Tool uninstalled', { toolId });
  }

  isInstalled(toolId: string): boolean {
    return this.installed.has(toolId);
  }

  listInstalled(): RegisteredTool[] {
    return runtimeRegistrar.list().filter((rt) =>
      this.installed.has(rt.tool.id),
    );
  }

  getInstallResult(toolId: string): InstallResult | undefined {
    return this.installed.get(toolId);
  }

  private async npmInstall(
    tool: ToolMetadata,
    packages: string[],
    installDir: string,
  ): Promise<string> {
    fs.mkdirSync(installDir, { recursive: true });

    const initPkg = path.join(installDir, 'package.json');
    if (!fs.existsSync(initPkg)) {
      fs.writeFileSync(
        initPkg,
        JSON.stringify({ name: `mcp-install-${tool.name}`, version: '1.0.0', private: true }, null, 2),
        'utf-8',
      );
    }

    if (packages.length > 0) {
      logger.info('Running npm install', {
        toolId: tool.id,
        packages,
        installDir,
      });

      try {
        const { stdout, stderr } = await execFileAsync(
          'npm',
          ['install', '--save', '--no-audit', '--no-fund', ...packages],
          { cwd: installDir, timeout: 120_000 },
        );

        if (stdout.trim()) logger.debug('npm stdout', { toolId: tool.id, stdout: stdout.trim() });
        if (stderr.trim()) logger.debug('npm stderr', { toolId: tool.id, stderr: stderr.trim() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`npm install failed for ${tool.id}: ${msg}`);
      }
    } else if (tool.installCommand) {
      logger.info('Running install command', {
        toolId: tool.id,
        command: tool.installCommand,
      });
      // For npx-style tools the package is fetched on first run, nothing to pre-install
    }

    return installDir;
  }

  /**
   * Remove the install directory to undo a partially-completed installation.
   * Emits `install:rollback` and records an audit entry.
   */
  private async rollback(
    tool: ToolMetadata,
    installDir: string,
    correlationId: string,
  ): Promise<void> {
    logger.warn('Rolling back installation', { toolId: tool.id, installDir });
    this.emit('install:rollback', { tool, installDir, correlationId });
    auditLog.record(
      'install.rollback',
      'system:installer',
      tool.id,
      'failure',
      correlationId,
      { installDir },
    );

    try {
      if (fs.existsSync(installDir)) {
        fs.rmSync(installDir, { recursive: true, force: true });
        logger.info('Rolled back install directory', { toolId: tool.id, installDir });
      }
    } catch (rollbackErr) {
      logger.error('Rollback failed', {
        toolId: tool.id,
        err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }
  }

  private fail(
    tool: ToolMetadata,
    error: string,
    startMs: number,
    correlationId?: string,
  ): InstallResult {
    const result: InstallResult = {
      success: false,
      tool,
      installedAt: new Date(),
      error,
    };

    auditLog.record(
      'tool.install',
      'system:installer',
      tool.id,
      'failure',
      correlationId,
      { error, duration: Date.now() - startMs },
    );

    metrics.increment('tools_install_failures_total', { source: tool.source });
    this.emit('failed', result);
    logger.error('Tool installation failed', { toolId: tool.id, error });

    return result;
  }
}

export const installer = new Installer();
