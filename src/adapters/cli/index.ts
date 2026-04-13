/**
 * src/adapters/cli/index.ts
 * Adapter that exposes local CLI tools as MCP tools.
 * Uses spawn (NOT exec/shell) to prevent shell injection.
 * Enforces configurable timeouts, argument validation, and restricted env.
 */

import { spawn } from 'child_process';
import { createLogger } from '../../observability/logger';
import { auditLog } from '../../security/audit';
import type { CliToolDefinition, CliExecutionResult, IAdapter } from '../../types/index';

const logger = createLogger('cli-adapter');

/**
 * Pattern of shell metacharacters that must not appear in CLI arguments.
 * If detected, the execution is refused to prevent injection attacks.
 */
const SHELL_METACHAR_RE = /[;&|`$(){}[\]<>!#~\\*?'"\n\r]/;

export class CliAdapter implements IAdapter {
  readonly name = 'cli';
  readonly protocol = 'cli';

  private readonly tools = new Map<string, CliToolDefinition>();

  async initialize(): Promise<void> {
    logger.info('CLI adapter initialized', { registeredTools: this.tools.size });
  }

  async shutdown(): Promise<void> {
    logger.info('CLI adapter shut down');
  }

  /**
   * Register a CLI tool definition.
   */
  register(tool: CliToolDefinition): void {
    this.tools.set(tool.id, tool);
    logger.debug('CLI tool registered', { id: tool.id, command: tool.command });
  }

  /**
   * Deregister a CLI tool by ID.
   */
  deregister(id: string): boolean {
    return this.tools.delete(id);
  }

  getRegisteredTools(): CliToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a registered CLI tool with the given input params.
   * Validates input against the tool's schema, sanitizes args, and spawns the process.
   */
  async execute(
    toolId: string,
    inputParams: Record<string, unknown>,
    requestId?: string,
  ): Promise<CliExecutionResult> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`CLI tool '${toolId}' not found`);
    }

    // Validate input against the tool's Zod schema
    const validation = tool.inputSchema.safeParse(inputParams);
    if (!validation.success) {
      throw new Error(
        `Invalid input for CLI tool '${toolId}': ${validation.error.message}`,
      );
    }

    // Security: reject shell metacharacters.
    // First validate raw parameter values (user-supplied input before template resolution).
    // Then also validate resolved args for template args that had substitutions.
    const paramValues = Object.values(validation.data as Record<string, unknown>).map(String);
    for (const val of paramValues) {
      if (SHELL_METACHAR_RE.test(val)) {
        throw new Error(
          `Security: shell metacharacter detected in input parameter value '${val}' for tool '${toolId}'. ` +
            'Sanitize the input.',
        );
      }
    }

    const resolvedArgs = this.resolveArgs(tool.args, validation.data);

    // Also validate resolved template args to catch metacharacters injected via substitution.
    for (let i = 0; i < tool.args.length; i++) {
      const template = tool.args[i];
      const resolved = resolvedArgs[i];
      if (template !== undefined && resolved !== undefined && template !== resolved) {
        // This arg had a substitution — validate the resolved value
        if (SHELL_METACHAR_RE.test(resolved)) {
          throw new Error(
            `Security: shell metacharacter in resolved argument '${resolved}' for tool '${toolId}'. ` +
              'Sanitize the input.',
          );
        }
      }
    }

    const timeoutMs = tool.timeoutMs ?? 30_000;
    const result = await this.runProcess(tool.command, resolvedArgs, {
      timeoutMs,
      ...(tool.allowedEnvVars !== undefined ? { allowedEnvVars: tool.allowedEnvVars } : {}),
    });

    auditLog.record(
      'cli.tool.executed',
      'system',
      toolId,
      result.exitCode === 0 ? 'success' : 'failure',
      requestId,
      { exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut },
    );

    logger.debug('CLI tool executed', {
      toolId,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });

    return result;
  }

  private resolveArgs(
    templates: string[],
    params: Record<string, unknown>,
  ): string[] {
    return templates.map((template) =>
      template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = params[key];
        return val !== undefined ? String(val) : '';
      }),
    );
  }

  private runProcess(
    command: string,
    args: string[],
    options: { timeoutMs: number; allowedEnvVars?: string[] },
  ): Promise<CliExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let timedOut = false;

      // Build a minimal, restricted environment
      const env: Record<string, string> = {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin',
      };
      for (const k of options.allowedEnvVars ?? []) {
        const val = process.env[k];
        if (val !== undefined) env[k] = val;
      }

      // shell: false is critical — never use shell: true
      const child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill after 5s if SIGTERM is ignored
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5_000).unref();
      }, options.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
        });
      });
    });
  }
}

/** Singleton instance for use across the application. */
export const cliAdapter = new CliAdapter();
