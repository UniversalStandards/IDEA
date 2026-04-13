import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as crypto from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLogger } from '../security/audit';
import { config } from '../config';
import { policyEngine } from '../policy/policy-engine';
import { trustEvaluator } from '../policy/trust-evaluator';
import { approvalGate } from '../policy/approval-gates';
import { type ToolMetadata } from '../discovery/types';
import { dependencyResolver } from './dependency-resolver';
import { configGenerator } from './config-generator';
import { runtimeRegistrar, type RegisteredTool } from './runtime-registrar';

const logger = createLogger('installer');

export interface InstallOptions {
  dryRun?: boolean;
  expectedSha256?: string;
}

export interface InstallResult {
  success: boolean;
  tool: ToolMetadata;
  installedAt: Date;
  path?: string;
  error?: string;
}

const INSTALL_BASE_DIR = path.resolve(process.cwd(), '.mcp', 'installed');
const LOCK_BASE_DIR = path.resolve(process.cwd(), 'runtime', 'locks');

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

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let timer: NodeJS.Timeout | null = null;
    if (options.timeout !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(new Error(`Process timed out after ${options.timeout}ms: ${command} ${args.join(' ')}`));
      }, options.timeout);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timer !== null) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(
          `Process exited with code ${String(code)}: ${command} ${args.join(' ')}\nstderr: ${stderr}`,
        ));
      }
    });
  });
}

async function acquireLock(toolId: string): Promise<void> {
  await fsp.mkdir(LOCK_BASE_DIR, { recursive: true });
  const lockPath = path.join(LOCK_BASE_DIR, `${toolId}.lock`);
  try {
    await fsp.writeFile(lockPath, String(Date.now()), { flag: 'wx' });
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EEXIST') {
      throw new Error(`Install lock already held for tool: ${toolId}`);
    }
    throw err;
  }
}

async function releaseLock(toolId: string): Promise<void> {
  const lockPath = path.join(LOCK_BASE_DIR, `${toolId}.lock`);
  try {
    await fsp.unlink(lockPath);
  } catch {
    // Lock may already be gone; ignore
  }
}

async function rollback(installDir: string): Promise<void> {
  try {
    await fsp.rm(installDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Rollback failed to remove install directory', {
      installDir,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function computeDirectoryChecksum(dir: string): Promise<string> {
  const entries: Array<{ filePath: string; size: number }> = [];

  async function walk(current: string): Promise<void> {
    const items = await fsp.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const stat = await fsp.stat(fullPath);
        entries.push({ filePath: fullPath.slice(dir.length), size: stat.size });
      }
    }
  }

  await walk(dir);
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath));

  const manifest = entries.map((e) => `${e.filePath}:${e.size}`).join('\n');
  return crypto.createHash('sha256').update(manifest, 'utf-8').digest('hex');
}

export class Installer extends EventEmitter {
  private readonly semaphore: Semaphore;
  private readonly installed: Map<string, InstallResult> = new Map();

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

  async install(tool: ToolMetadata, options?: InstallOptions): Promise<InstallResult> {
    const start = Date.now();
    const dryRun = options?.dryRun === true;
    logger.info('Install requested', { toolId: tool.id, name: tool.name, dryRun });
    this.emit('installing', tool);

    let semaphoreAcquired = false;
    let lockAcquired = false;
    let installDirCreated = false;
    const installDir = path.join(INSTALL_BASE_DIR, tool.name);

    try {
      // Acquire per-tool lock file to prevent concurrent cross-process installs
      try {
        await acquireLock(tool.id);
        lockAcquired = true;
      } catch (lockErr) {
        const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
        return this.fail(tool, msg, start);
      }

      await this.semaphore.acquire();
      semaphoreAcquired = true;

      // Stage 1: Policy check
      this.emit('install:stage', { stage: 'policy-check', toolId: tool.id });
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
        return this.fail(tool, err, start);
      }

      // Stage 2: Trust evaluation
      this.emit('install:stage', { stage: 'trust-evaluation', toolId: tool.id });
      const trustInput = {
        id: tool.id,
        name: tool.name,
        version: tool.version,
        source: mapToolSourceForTrust(tool.source),
        ...(tool.verified !== undefined ? { signatureValid: tool.verified } : {}),
        ...(tool.downloadCount !== undefined ? { downloadCount: tool.downloadCount } : {}),
        ...(tool.author !== undefined ? { author: tool.author } : {}),
        ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
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
        return this.fail(tool, err, start);
      }

      // Stage 3: Approval gate if required
      if (decision.requiresApproval || trustScore.score < minRequired) {
        this.emit('install:stage', { stage: 'approval-requested', toolId: tool.id });
        try {
          await approvalGate.request(
            tool.id,
            'install',
            'system:installer',
            `Install tool ${tool.name}@${tool.version} (trust: ${trustScore.score}, level: ${trustScore.level})`,
            { trustScore, policyReasons: decision.reasons },
          );
          this.emit('install:stage', { stage: 'approved', toolId: tool.id });
          logger.info('Install approved', { toolId: tool.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.fail(tool, `Approval denied or timed out: ${msg}`, start);
        }
      }

      // Stage 4: Dependency resolution
      this.emit('install:stage', { stage: 'dependency-resolution', toolId: tool.id });
      const resolved = dependencyResolver.resolve(tool);

      if (resolved.conflicts.length > 0) {
        logger.warn('Dependency conflicts detected, proceeding with caution', {
          toolId: tool.id,
          conflicts: resolved.conflicts,
        });
      }

      // Dry-run: all validation steps complete — skip file system operations
      if (dryRun) {
        logger.info('Dry run complete — no files written', { toolId: tool.id });
        this.emit('install:stage', { stage: 'dry-run-complete', toolId: tool.id });
        const dryResult: InstallResult = {
          success: true,
          tool,
          installedAt: new Date(),
        };
        return dryResult;
      }

      // Stage 5: npm install
      this.emit('install:stage', { stage: 'npm-install', toolId: tool.id });
      installDirCreated = true; // set before call so catch can rollback partial writes
      const installPath = await this.npmInstall(tool, resolved.installOrder, installDir);

      // Stage 6: Checksum verification (when caller supplied an expected digest)
      if (options?.expectedSha256 !== undefined) {
        this.emit('install:stage', { stage: 'checksum-verification', toolId: tool.id });
        const actualChecksum = await computeDirectoryChecksum(installDir);
        if (actualChecksum !== options.expectedSha256) {
          logger.error('Checksum mismatch — rolling back', {
            toolId: tool.id,
            expected: options.expectedSha256,
            actual: actualChecksum,
          });
          await rollback(installDir);
          installDirCreated = false;
          throw new Error(
            `Checksum mismatch for ${tool.id}: expected ${options.expectedSha256}, got ${actualChecksum}`,
          );
        }
        logger.info('Checksum verified', { toolId: tool.id });
        this.emit('install:stage', { stage: 'checksum-verified', toolId: tool.id });
      }

      // Stage 7: Config generation
      this.emit('install:stage', { stage: 'config-generation', toolId: tool.id });
      const runtimeConfig = configGenerator.generate(tool, {});

      // Stage 8: Runtime registration
      this.emit('install:stage', { stage: 'registration', toolId: tool.id });
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

      auditLogger.log({
        actor: 'system:installer',
        action: 'tool.install',
        resource: tool.id,
        outcome: 'success',
        metadata: { path: installPath, duration: Date.now() - start },
      });

      this.emit('installed', result);
      logger.info('Tool installed successfully', {
        toolId: tool.id,
        path: installPath,
        durationMs: Date.now() - start,
      });

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (installDirCreated) {
        logger.info('Rolling back installation', { toolId: tool.id, installDir });
        await rollback(installDir);
      }
      return this.fail(tool, msg, start);
    } finally {
      if (semaphoreAcquired) this.semaphore.release();
      if (lockAcquired) await releaseLock(tool.id);
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
        await spawnAsync(
          'npm',
          ['uninstall', installResult.tool.name],
          { cwd: installDir, timeout: 60_000 },
        );
      } catch (err) {
        logger.warn('npm uninstall failed, removing directory anyway', {
          toolId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await fsp.rm(installDir, { recursive: true, force: true });
    }

    this.installed.delete(toolId);

    auditLogger.log({
      actor: 'system:installer',
      action: 'tool.uninstall',
      resource: toolId,
      outcome: 'success',
    });

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

      const { stdout, stderr } = await spawnAsync(
        'npm',
        ['install', '--save', '--no-audit', '--no-fund', ...packages],
        { cwd: installDir, timeout: 120_000 },
      );

      if (stdout.trim()) logger.debug('npm stdout', { toolId: tool.id, stdout: stdout.trim() });
      if (stderr.trim()) logger.debug('npm stderr', { toolId: tool.id, stderr: stderr.trim() });
    } else if (tool.installCommand) {
      logger.info('Running install command', {
        toolId: tool.id,
        command: tool.installCommand,
      });
      // For npx-style tools the package is fetched on first run, nothing to pre-install
    }

    return installDir;
  }

  private fail(tool: ToolMetadata, error: string, startMs: number): InstallResult {
    const result: InstallResult = {
      success: false,
      tool,
      installedAt: new Date(),
      error,
    };

    auditLogger.log({
      actor: 'system:installer',
      action: 'tool.install',
      resource: tool.id,
      outcome: 'failure',
      metadata: { error, duration: Date.now() - startMs },
    });

    metrics.increment('tools_install_failures_total', { source: tool.source });
    this.emit('failed', result);
    logger.error('Tool installation failed', { toolId: tool.id, error });

    return result;
  }
}

export const installer = new Installer();
