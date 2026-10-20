import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLog } from '../security/audit';
import { config, resolveHubDataDir } from '../config';
import { policyEngine } from '../policy/policy-engine';
import { trustEvaluator } from '../policy/trust-evaluator';
import { approvalGate } from '../policy/approval-gates';
import { type ToolMetadata } from '../discovery/types';
import { dependencyResolver } from './dependency-resolver';
import { configGenerator } from './config-generator';
import { buildInstallerEnv, runtimeRegistrar, type RegisteredTool } from './runtime-registrar';
import { InstallStateStore, type InstalledRecord } from './install-state';

const logger = createLogger('installer');
const execFileAsync = promisify(execFile);

export interface InstallResult {
  success: boolean;
  tool: ToolMetadata;
  installedAt: Date;
  path?: string;
  error?: string;
}

export interface InstallOptions {
  /**
   * The caller has already obtained approval for this install (MCP
   * elicitation, an approved approval request, or the operator allowlist),
   * so the blocking approval gate is skipped. Explicit policy denials and
   * the trust floor still apply.
   */
  readonly preApproved?: boolean;
  /** Extra launch arguments for the tool (e.g. allowed directories). */
  readonly args?: string[];
  /** Actor recorded in policy evaluation and the audit log. */
  readonly actor?: string;
}

/** Outcome of the governance checks that gate an install. */
export interface InstallAssessment {
  /** Set when the install is refused outright (no approval can override). */
  readonly denied?: string;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly trustScore: number;
  readonly trustLevel: string;
  readonly minimumTrust: number;
}

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 4_096;

function hubDataDir(): string {
  try {
    return resolveHubDataDir(config);
  } catch {
    return resolveHubDataDir({ HUB_DATA_DIR: process.env['HUB_DATA_DIR'] });
  }
}

function readConfig<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Directory-safe name for a tool's install directory. */
export function safeInstallDirName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 128) : 'tool';
}

/**
 * npm packages to pre-install for a tool: explicit `dependencies`, or — for
 * the common `npx [-y|--yes] <package> …` launch form — the launched package
 * itself, so the first execution is local and offline-capable instead of
 * downloading on demand.
 */
export function packagesForTool(tool: ToolMetadata, explicit: string[]): string[] {
  if (explicit.length > 0) return explicit;
  const parts = tool.installCommand?.trim().split(/\s+/) ?? [];
  if (parts[0] !== 'npx') return [];
  const pkg = parts.slice(1).find((p) => !p.startsWith('-'));
  if (pkg === undefined) return [];
  // npm package spec: optional @scope/, name, optional @version.
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*|-]+)?$/i.test(pkg) ? [pkg] : [];
}

function validateArgs(args: string[] | undefined): string[] {
  if (args === undefined) return [];
  if (args.length > MAX_ARGS) {
    throw new Error(`Too many launch arguments (max ${MAX_ARGS})`);
  }
  for (const a of args) {
    if (a.length > MAX_ARG_LENGTH || a.includes('\0')) {
      throw new Error('Launch arguments must be under 4 KiB and must not contain NUL bytes');
    }
  }
  return [...args];
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
    const next = this.queue.shift();
    if (next !== undefined) {
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
  private readonly installArgs: Map<string, string[]> = new Map();
  private readonly inFlight: Map<string, Promise<InstallResult>> = new Map();
  private readonly baseDir: string;
  private readonly stateStore: InstallStateStore;

  constructor(options: { baseDir?: string; stateFile?: string } = {}) {
    super();

    const maxConcurrent = readConfig(
      () => config.MAX_CONCURRENT_INSTALLS,
      parseInt(process.env['MAX_CONCURRENT_INSTALLS'] ?? '5', 10),
    );
    this.semaphore = new Semaphore(maxConcurrent);

    const dataDir = hubDataDir();
    this.baseDir = path.resolve(options.baseDir ?? path.join(dataDir, 'installed'));
    this.stateStore = new InstallStateStore(
      options.stateFile ?? path.join(dataDir, 'state', 'installed-tools.json'),
    );
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /** Governance checks for installing `tool`, without side effects. */
  assess(tool: ToolMetadata, actor = 'system:installer'): InstallAssessment {
    const decision = policyEngine.evaluate({
      toolId: tool.id,
      actor,
      action: 'install',
      environment: process.env['NODE_ENV'] ?? 'development',
      metadata: { source: tool.source, version: tool.version },
    });

    const trustInput: Parameters<typeof trustEvaluator.evaluate>[0] = {
      id: tool.id,
      name: tool.name,
      version: tool.version,
      source: mapToolSourceForTrust(tool.source),
      ...(tool.verified !== undefined ? { signatureValid: tool.verified } : {}),
      ...(tool.downloadCount !== undefined ? { downloadCount: tool.downloadCount } : {}),
      ...(tool.author !== undefined ? { author: tool.author } : {}),
      ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
    };
    const trust = trustEvaluator.evaluate(trustInput);
    const minimumTrust = trustEvaluator.getMinimumRequired('install');
    const lowTrust = trust.score < minimumTrust;

    const base = {
      reasons: decision.reasons,
      trustScore: trust.score,
      trustLevel: String(trust.level),
      minimumTrust,
    };

    if (!decision.allowed && !decision.requiresApproval) {
      return { ...base, denied: `Policy denied installation: ${decision.reasons.join('; ')}`, requiresApproval: false };
    }
    if (lowTrust && !decision.requiresApproval) {
      return {
        ...base,
        denied: `Trust score ${trust.score} below minimum ${minimumTrust} for installation`,
        requiresApproval: false,
      };
    }
    return { ...base, requiresApproval: decision.requiresApproval || lowTrust };
  }

  /**
   * Install a tool. Concurrent installs of the same tool share one operation;
   * different tools are limited by MAX_CONCURRENT_INSTALLS.
   */
  async install(tool: ToolMetadata, options: InstallOptions = {}): Promise<InstallResult> {
    const existing = this.inFlight.get(tool.id);
    if (existing) return existing;

    const run = this.doInstall(tool, options).finally(() => {
      this.inFlight.delete(tool.id);
    });
    this.inFlight.set(tool.id, run);
    return run;
  }

  private async doInstall(tool: ToolMetadata, options: InstallOptions): Promise<InstallResult> {
    const start = Date.now();
    const actor = options.actor ?? 'system:installer';
    logger.info('Install requested', { toolId: tool.id, name: tool.name, actor });
    this.emit('installing', tool);

    await this.semaphore.acquire();

    let installDir: string | undefined;
    let createdDir = false;
    try {
      const args = validateArgs(options.args);

      // Steps 1–2: policy and trust
      const assessment = this.assess(tool, actor);
      logger.info('Install assessed', {
        toolId: tool.id,
        score: assessment.trustScore,
        level: assessment.trustLevel,
        minRequired: assessment.minimumTrust,
        requiresApproval: assessment.requiresApproval,
      });
      if (assessment.denied !== undefined) {
        return this.fail(tool, assessment.denied, start);
      }

      // Step 3: approval gate (blocking) unless the caller already holds approval
      if (assessment.requiresApproval && options.preApproved !== true) {
        try {
          await approvalGate.request(
            tool.id,
            'install',
            actor,
            `Install tool ${tool.name}@${tool.version} (trust: ${assessment.trustScore}, level: ${assessment.trustLevel})`,
            { trustScore: assessment.trustScore, policyReasons: assessment.reasons },
          );
          logger.info('Install approved', { toolId: tool.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return this.fail(tool, `Approval denied or timed out: ${msg}`, start);
        }
      }

      // Step 4: dependency resolution
      const resolved = dependencyResolver.resolve(tool);
      if (resolved.conflicts.length > 0) {
        logger.warn('Dependency conflicts detected, proceeding with caution', {
          toolId: tool.id,
          conflicts: resolved.conflicts,
        });
      }

      // Step 5: npm install into an isolated per-tool directory
      installDir = this.installDirFor(tool);
      createdDir = !fs.existsSync(installDir);
      const packages = packagesForTool(tool, resolved.installOrder);
      await this.npmInstall(tool, packages, installDir);

      // Step 6: runtime config — the tool runs from its install directory so
      // `npx <pkg>` resolves the locally installed package
      const generated = configGenerator.generate(tool, {});
      const runtimeConfig = {
        ...generated,
        args: [...generated.args, ...args],
        workingDir: installDir,
      };

      // Step 7: runtime registration + durable state
      runtimeRegistrar.register(tool, runtimeConfig);

      const result: InstallResult = {
        success: true,
        tool,
        installedAt: new Date(),
        path: installDir,
      };
      this.installed.set(tool.id, result);
      this.installArgs.set(tool.id, args);
      this.persist();

      metrics.increment('tools_installed_total', { source: tool.source });
      metrics.histogram('tool_install_duration_ms', Date.now() - start);
      auditLog.record('tool.install', actor, tool.id, 'success', undefined, {
        path: installDir,
        packages,
        duration: Date.now() - start,
      });

      this.emit('installed', result);
      logger.info('Tool installed successfully', {
        toolId: tool.id,
        path: installDir,
        packages,
        durationMs: Date.now() - start,
      });

      return result;
    } catch (err) {
      // Roll back a partially created install directory
      if (installDir !== undefined && createdDir) {
        fs.rmSync(installDir, { recursive: true, force: true });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.fail(tool, msg, start);
    } finally {
      this.semaphore.release();
    }
  }

  async uninstall(toolId: string, actor = 'system:installer'): Promise<void> {
    logger.info('Uninstall requested', { toolId, actor });

    const installResult = this.installed.get(toolId);
    if (!installResult) {
      throw new Error(`Tool not installed: ${toolId}`);
    }

    runtimeRegistrar.unregister(toolId);

    const installDir = installResult.path ?? this.installDirFor(installResult.tool);
    if (this.isWithinBaseDir(installDir) && fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
    }

    this.installed.delete(toolId);
    this.installArgs.delete(toolId);
    this.persist();

    auditLog.record('tool.uninstall', actor, toolId, 'success');
    metrics.increment('tools_uninstalled_total');
    this.emit('uninstalled', toolId);
    logger.info('Tool uninstalled', { toolId });
  }

  /**
   * Re-register tools recorded in the install state file whose install
   * directory still exists. Returns the number of tools restored.
   */
  restore(): number {
    const records = this.stateStore.load();
    let restored = 0;
    for (const record of records) {
      if (!this.isWithinBaseDir(record.installPath) || !fs.existsSync(record.installPath)) {
        logger.warn('Skipping install record whose directory is missing', {
          toolId: record.tool.id,
          installPath: record.installPath,
        });
        continue;
      }
      const generated = configGenerator.generate(record.tool, {});
      runtimeRegistrar.register(record.tool, {
        ...generated,
        args: [...generated.args, ...record.args],
        workingDir: record.installPath,
      });
      this.installed.set(record.tool.id, {
        success: true,
        tool: record.tool,
        installedAt: new Date(record.installedAt),
        path: record.installPath,
      });
      this.installArgs.set(record.tool.id, record.args);
      restored++;
    }
    if (records.length > 0) {
      logger.info('Install state restored', { restored, recorded: records.length });
    }
    return restored;
  }

  isInstalled(toolId: string): boolean {
    return this.installed.has(toolId);
  }

  listInstalled(): RegisteredTool[] {
    return runtimeRegistrar.list().filter((rt) => this.installed.has(rt.tool.id));
  }

  getInstallResult(toolId: string): InstallResult | undefined {
    return this.installed.get(toolId);
  }

  private installDirFor(tool: ToolMetadata): string {
    const dir = path.resolve(this.baseDir, safeInstallDirName(tool.name));
    if (!this.isWithinBaseDir(dir)) {
      throw new Error(`Refusing to install outside ${this.baseDir}`);
    }
    return dir;
  }

  private isWithinBaseDir(candidate: string): boolean {
    const rel = path.relative(this.baseDir, path.resolve(candidate));
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private persist(): void {
    const records: InstalledRecord[] = Array.from(this.installed.values())
      .filter((r) => r.success && r.path !== undefined)
      .map((r) => ({
        tool: r.tool,
        args: this.installArgs.get(r.tool.id) ?? [],
        installPath: r.path ?? '',
        installedAt: r.installedAt.toISOString(),
      }));
    try {
      this.stateStore.save(records);
    } catch (err) {
      // Non-fatal: the install itself succeeded; it just will not survive a restart.
      logger.error('Failed to persist install state', {
        file: this.stateStore.getFilePath(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async npmInstall(
    tool: ToolMetadata,
    packages: string[],
    installDir: string,
  ): Promise<void> {
    fs.mkdirSync(installDir, { recursive: true });

    const initPkg = path.join(installDir, 'package.json');
    if (!fs.existsSync(initPkg)) {
      fs.writeFileSync(
        initPkg,
        JSON.stringify(
          { name: `mcp-install-${safeInstallDirName(tool.name).toLowerCase()}`, version: '1.0.0', private: true },
          null,
          2,
        ),
        'utf-8',
      );
    }

    if (packages.length === 0) {
      logger.info('No npm packages to pre-install', { toolId: tool.id, installCommand: tool.installCommand });
      return;
    }

    const allowScripts = readConfig(
      () => config.INSTALL_ALLOW_LIFECYCLE_SCRIPTS,
      process.env['INSTALL_ALLOW_LIFECYCLE_SCRIPTS'] === 'true',
    );
    const timeout = readConfig(() => config.INSTALL_TIMEOUT_MS, 300_000);
    const npmArgs = [
      'install',
      '--save',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      ...(allowScripts ? [] : ['--ignore-scripts']),
      ...packages,
    ];

    logger.info('Running npm install', { toolId: tool.id, packages, installDir, allowScripts });

    try {
      const { stdout, stderr } = await execFileAsync('npm', npmArgs, {
        cwd: installDir,
        // npm (and any opted-in lifecycle scripts) never sees hub secrets.
        env: buildInstallerEnv(),
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (stdout.trim()) logger.debug('npm stdout', { toolId: tool.id, stdout: stdout.trim() });
      if (stderr.trim()) logger.debug('npm stderr', { toolId: tool.id, stderr: stderr.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`npm install failed for ${tool.id}: ${msg}`);
    }
  }

  private fail(tool: ToolMetadata, error: string, startMs: number): InstallResult {
    const result: InstallResult = {
      success: false,
      tool,
      installedAt: new Date(),
      error,
    };

    auditLog.record('tool.install', 'system:installer', tool.id, 'failure', undefined, {
      error,
      duration: Date.now() - startMs,
    });

    metrics.increment('tools_install_failures_total', { source: tool.source });
    this.emit('failed', result);
    logger.error('Tool installation failed', { toolId: tool.id, error });

    return result;
  }
}

export const installer = new Installer();
