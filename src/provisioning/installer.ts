import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLogger } from '../security/audit';
import { config } from '../config';
import { policyEngine } from '../policy/policy-engine';
import { trustEvaluator } from '../policy/trust-evaluator';
import { approvalGate } from '../policy/approval-gates';
import { ToolMetadata } from '../discovery/types';
import { dependencyResolver } from './dependency-resolver';
import { configGenerator } from './config-generator';
import { runtimeRegistrar, RegisteredTool } from './runtime-registrar';

const logger = createLogger('installer');
const execFileAsync = promisify(execFile);

export interface InstallResult {
  success: boolean;
  tool: ToolMetadata;
  installedAt: Date;
  path?: string;
  error?: string;
}

const INSTALL_BASE_DIR = path.resolve(process.cwd(), '.mcp', 'installed');

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

  async install(tool: ToolMetadata): Promise<InstallResult> {
    const start = Date.now();
    logger.info('Install requested', { toolId: tool.id, name: tool.name });
    this.emit('installing', tool);

    await this.semaphore.acquire();

    try {
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
        return this.fail(tool, err, start);
      }

      // Step 2: Trust evaluation
      const trustInput = {
        id: tool.id,
        name: tool.name,
        version: tool.version,
        source: mapToolSourceForTrust(tool.source),
        signatureValid: tool.verified,
        downloadCount: tool.downloadCount,
        author: tool.author,
        metadata: tool.metadata,
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
          return this.fail(tool, `Approval denied or timed out: ${msg}`, start);
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

      // Step 5: npm install
      const installDir = path.join(INSTALL_BASE_DIR, tool.name);
      const installPath = await this.npmInstall(tool, resolved.installOrder, installDir);

      // Step 6: Config generation
      const runtimeConfig = configGenerator.generate(tool, {});

      // Step 7: Runtime registration
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
      return this.fail(tool, msg, start);
    } finally {
      this.semaphore.release();
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
