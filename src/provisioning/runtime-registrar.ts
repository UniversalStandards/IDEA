import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLog } from '../security/audit';
import { type ToolMetadata } from '../discovery/types';
import { type ToolRuntimeConfig } from './config-generator';

const logger = createLogger('runtime-registrar');

export interface RegisteredTool {
  tool: ToolMetadata;
  config: ToolRuntimeConfig;
  registeredAt: Date;
  status: 'registered' | 'running' | 'stopped' | 'error';
  // These three are cleared back to `undefined` in place (not omitted) as the
  // tool's process lifecycle transitions, so — unlike a cross-boundary payload
  // type — they are declared `| undefined` rather than merely optional (`?`):
  // under exactOptionalPropertyTypes, `?` permits omitting the key, not
  // assigning `undefined` to it.
  process: ChildProcess | undefined;
  pid: number | undefined;
  errorMessage: string | undefined;
}

/** Everything needed to launch a registered tool as a stdio MCP server. */
export interface ToolLaunchSpec {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  /** Tool-specific variables only; callers add the minimal base env. */
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

/**
 * Environment for a tool process: the SDK's minimal safe base (PATH, HOME,
 * USER, …) plus the tool's own configured variables. The hub's own process
 * environment — JWT_SECRET, ENCRYPTION_KEY, MCP_AUTH_TOKEN, provider API
 * keys — is never inherited by third-party tool code.
 */
export function buildToolProcessEnv(
  toolEnv: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...getDefaultEnvironment(), ...networkEnv(source), ...toolEnv };
}

/**
 * Proxy, trust-store and package-runtime variables. Tools (and npm/uvx)
 * need these to reach the network from behind a corporate proxy or
 * TLS-inspecting gateway and to reuse the persistent package caches; they
 * carry no hub secrets.
 */
const NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'TZ',
  'LANG',
  // Package-runtime locations/indexes (uvx for Python servers, npm for npx)
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'UV_TOOL_DIR',
  'UV_INDEX_URL',
  'UV_DEFAULT_INDEX',
  'PIP_INDEX_URL',
  'NPM_CONFIG_REGISTRY',
  'npm_config_registry',
];

export function networkEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of NETWORK_ENV_KEYS) {
    const v = source[key];
    if (v !== undefined && v !== '') out[key] = v;
  }
  return out;
}

/**
 * Environment for npm itself during installs: the tool-process base plus
 * npm's own configuration (registry, proxy, cafile, auth) from
 * npm_config_* / NPM_CONFIG_* variables.
 */
export function buildInstallerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out = buildToolProcessEnv({}, source);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && /^npm_config_/i.test(key)) out[key] = value;
  }
  return out;
}

export class RuntimeRegistrar {
  private readonly registry: Map<string, RegisteredTool> = new Map();

  register(tool: ToolMetadata, config: ToolRuntimeConfig): RegisteredTool {
    const existing = this.registry.get(tool.id);
    if (existing) {
      logger.debug('Re-registering existing tool', { toolId: tool.id });
      if (existing.status === 'running' && existing.process) {
        this.stopProcess(tool.id, existing);
      }
    }

    const entry: RegisteredTool = {
      tool,
      config,
      registeredAt: new Date(),
      status: 'registered',
      process: undefined,
      pid: undefined,
      errorMessage: undefined,
    };

    this.registry.set(tool.id, entry);
    metrics.gauge('registered_tools_total', this.registry.size);

    auditLog.record('tool.register', 'system', tool.id, 'success', undefined, {
      name: tool.name,
      version: tool.version,
    });

    logger.info('Tool registered', { toolId: tool.id, name: tool.name });
    return entry;
  }

  unregister(toolId: string): void {
    const entry = this.registry.get(toolId);
    if (!entry) {
      logger.warn('Attempted to unregister unknown tool', { toolId });
      return;
    }

    if (entry.status === 'running' && entry.process) {
      this.stopProcess(toolId, entry);
    }

    this.registry.delete(toolId);
    metrics.gauge('registered_tools_total', this.registry.size);

    auditLog.record('tool.unregister', 'system', toolId, 'success');

    logger.info('Tool unregistered', { toolId });
  }

  get(toolId: string): RegisteredTool | undefined {
    return this.registry.get(toolId);
  }

  list(): RegisteredTool[] {
    return Array.from(this.registry.values());
  }

  isRunning(toolId: string): boolean {
    const entry = this.registry.get(toolId);
    return entry?.status === 'running' && entry.process !== undefined;
  }

  start(toolId: string): ChildProcess {
    const entry = this.registry.get(toolId);
    if (!entry) throw new Error(`Tool not registered: ${toolId}`);

    if (entry.status === 'running' && entry.process) {
      logger.debug('Tool already running', { toolId, pid: entry.pid });
      return entry.process;
    }

    const command = this.resolveCommand(entry);
    if (!command) {
      throw new Error(`Cannot resolve start command for tool: ${toolId}`);
    }

    logger.info('Starting tool process', {
      toolId,
      cmd: command.cmd,
      args: command.args,
      workingDir: entry.config.workingDir,
    });

    fs.mkdirSync(entry.config.workingDir, { recursive: true });
    const proc = spawn(command.cmd, command.args, {
      cwd: entry.config.workingDir,
      env: buildToolProcessEnv(entry.config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    entry.process = proc;
    entry.pid = proc.pid;
    entry.status = 'running';
    entry.errorMessage = undefined;

    proc.stdout?.on('data', (data: Buffer) => {
      logger.debug('Tool stdout', { toolId, data: data.toString().trim() });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      logger.debug('Tool stderr', { toolId, data: data.toString().trim() });
    });

    proc.on('exit', (code, signal) => {
      const current = this.registry.get(toolId);
      if (current?.process === proc) {
        current.status = code === 0 ? 'stopped' : 'error';
        current.process = undefined;
        current.pid = undefined;
        if (code !== 0) {
          current.errorMessage = `Process exited with code ${code ?? 'unknown'}, signal: ${signal ?? 'none'}`;
        }
        metrics.increment('tool_process_exits_total', {
          toolId,
          code: String(code ?? 'unknown'),
        });
        logger.info('Tool process exited', { toolId, code, signal });
      }
    });

    proc.on('error', (err) => {
      const current = this.registry.get(toolId);
      if (current) {
        current.status = 'error';
        current.process = undefined;
        current.pid = undefined;
        current.errorMessage = err.message;
      }
      logger.error('Tool process error', { toolId, err });
      metrics.increment('tool_process_errors_total', { toolId });
    });

    auditLog.record('tool.start', 'system', toolId, 'success', undefined, { pid: proc.pid });

    metrics.increment('tool_process_starts_total', { toolId });
    return proc;
  }

  stop(toolId: string): void {
    const entry = this.registry.get(toolId);
    if (!entry) {
      logger.warn('Attempted to stop unknown tool', { toolId });
      return;
    }

    if (entry.status !== 'running' || !entry.process) {
      logger.debug('Tool not running, nothing to stop', { toolId });
      return;
    }

    this.stopProcess(toolId, entry);
  }

  private stopProcess(toolId: string, entry: RegisteredTool): void {
    if (!entry.process) return;

    const proc = entry.process;

    try {
      proc.kill('SIGTERM');

      const killTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
          logger.warn('Sent SIGKILL after SIGTERM timeout', { toolId });
        }
      }, 5_000);

      killTimer.unref();
    } catch (err) {
      logger.warn('Error killing tool process', {
        toolId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    entry.status = 'stopped';
    entry.process = undefined;
    entry.pid = undefined;

    auditLog.record('tool.stop', 'system', toolId, 'success');

    logger.info('Tool process stopped', { toolId });
  }

  /**
   * Resolve how to launch a registered tool as a stdio MCP server, or
   * undefined when the tool is unknown or has no resolvable command.
   */
  getLaunchSpec(toolId: string): ToolLaunchSpec | undefined {
    const entry = this.registry.get(toolId);
    if (!entry) return undefined;
    const command = this.resolveCommand(entry);
    if (!command) return undefined;
    fs.mkdirSync(entry.config.workingDir, { recursive: true });
    return {
      command: command.cmd,
      args: command.args,
      cwd: entry.config.workingDir,
      env: { ...entry.config.env },
      timeoutMs: entry.config.timeout,
    };
  }

  private resolveCommand(entry: RegisteredTool): { cmd: string; args: string[] } | null {
    const { tool, config: cfg } = entry;

    if (tool.installCommand) {
      const parts = tool.installCommand.trim().split(/\s+/);
      const cmd = parts[0];
      if (cmd) return { cmd, args: [...parts.slice(1), ...cfg.args] };
    }

    if (tool.entryPoint) {
      return { cmd: 'node', args: [tool.entryPoint, ...cfg.args] };
    }

    const metaCmd = tool.metadata?.['command'];
    if (typeof metaCmd === 'string') {
      const parts = metaCmd.trim().split(/\s+/);
      const cmd = parts[0];
      if (cmd) return { cmd, args: [...parts.slice(1), ...cfg.args] };
    }

    return null;
  }
}

export const runtimeRegistrar = new RuntimeRegistrar();
