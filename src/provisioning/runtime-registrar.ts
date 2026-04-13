import { type ChildProcess, spawn } from 'child_process';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { auditLogger } from '../security/audit';
import { type ToolMetadata } from '../discovery/types';
import { type ToolRuntimeConfig } from './config-generator';

const logger = createLogger('runtime-registrar');

export interface RegisteredTool {
  tool: ToolMetadata;
  config: ToolRuntimeConfig;
  registeredAt: Date;
  status: 'registered' | 'running' | 'stopped' | 'error';
  process?: ChildProcess;
  pid?: number;
  errorMessage?: string;
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
    };

    this.registry.set(tool.id, entry);
    metrics.gauge('registered_tools_total', this.registry.size);

    auditLogger.log({
      actor: 'system',
      action: 'tool.register',
      resource: tool.id,
      outcome: 'success',
      metadata: { name: tool.name, version: tool.version },
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

    auditLogger.log({
      actor: 'system',
      action: 'tool.unregister',
      resource: toolId,
      outcome: 'success',
    });

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

    const proc = spawn(command.cmd, command.args, {
      cwd: entry.config.workingDir,
      env: { ...process.env, ...entry.config.env },
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

    auditLogger.log({
      actor: 'system',
      action: 'tool.start',
      resource: toolId,
      outcome: 'success',
      metadata: { pid: proc.pid },
    });

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

    auditLogger.log({
      actor: 'system',
      action: 'tool.stop',
      resource: toolId,
      outcome: 'success',
    });

    logger.info('Tool process stopped', { toolId });
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
