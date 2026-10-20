/**
 * src/adapters/mcp/downstream.ts
 * Client-side connections from the hub to the MCP servers it has installed.
 *
 * The hub is an MCP *server* to its clients and an MCP *client* to every tool
 * it provisions. Each installed tool is launched on demand as a stdio MCP
 * server (one child process per tool, shared by all hub sessions), kept warm
 * while in use, and reaped after DOWNSTREAM_IDLE_TIMEOUT_MS of inactivity.
 *
 * Child processes receive only the SDK's minimal safe environment plus the
 * tool's own configured variables — never the hub's secrets.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getServiceVersion } from '../../version';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import {
  buildToolProcessEnv,
  runtimeRegistrar,
  type ToolLaunchSpec,
} from '../../provisioning/runtime-registrar';
import { config } from '../../config';

const logger = createLogger('mcp-downstream');

const MAX_STDERR_LINE = 2_000;

export type DownstreamErrorCode = 'NOT_REGISTERED' | 'RUNTIME_MISSING' | 'LAUNCH_FAILED';

export class DownstreamError extends Error {
  constructor(
    readonly code: DownstreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DownstreamError';
  }
}

/** A tool exposed by a downstream MCP server (subset of the MCP Tool shape). */
export interface DownstreamTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

/** Minimal client surface used by the manager (lets tests inject fakes). */
export interface DownstreamClient {
  connect(transport: Transport, options?: { timeout?: number }): Promise<void>;
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number },
  ): Promise<{ tools: DownstreamTool[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
}

export interface DownstreamClientManagerOptions {
  /** Returns how to launch a tool, or undefined when it is not registered. */
  readonly resolveLaunchSpec: (toolId: string) => ToolLaunchSpec | undefined;
  readonly idleTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly now?: () => number;
  readonly clientFactory?: () => DownstreamClient;
  readonly transportFactory?: (spec: ToolLaunchSpec) => Transport;
}

interface Connection {
  readonly toolId: string;
  readonly client: DownstreamClient;
  lastUsedAt: number;
  inFlight: number;
  /** tools/list result for this connection (invalidated when it closes). */
  tools?: DownstreamTool[];
}

function defaultClientFactory(): DownstreamClient {
  // The SDK Client satisfies DownstreamClient structurally; its listTools
  // result carries extra optional fields that are simply ignored here.
  return new Client(
    { name: 'universal-standard-mcp-server', version: getServiceVersion() },
    { capabilities: {} },
  ) as unknown as DownstreamClient;
}

function defaultTransportFactory(spec: ToolLaunchSpec): Transport {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: buildToolProcessEnv(spec.env),
    stderr: 'pipe',
  });
  const stderr = transport.stderr;
  if (stderr) {
    let buffered = '';
    stderr.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let idx = buffered.indexOf('\n');
      while (idx >= 0) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (line.length > 0) {
          logger.debug('Downstream stderr', { command: spec.command, line: line.slice(0, MAX_STDERR_LINE) });
        }
        idx = buffered.indexOf('\n');
      }
    });
  }
  return transport;
}

/** Normalize a tools/call result, including the legacy `toolResult` shape. */
export function normalizeCallResult(raw: Record<string, unknown>): CallToolResult {
  if (Array.isArray(raw['content'])) {
    return raw as unknown as CallToolResult;
  }
  if ('toolResult' in raw) {
    return {
      content: [{ type: 'text', text: JSON.stringify(raw['toolResult'], null, 2) }],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
}

function describeLaunchError(spec: ToolLaunchSpec, err: unknown): DownstreamError {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || /ENOENT|not found|spawn .* ENOENT/i.test(message)) {
    return new DownstreamError(
      'RUNTIME_MISSING',
      `Runtime '${spec.command}' is not available in this hub environment (${message})`,
    );
  }
  return new DownstreamError('LAUNCH_FAILED', `Failed to start '${spec.command}': ${message}`);
}

export class DownstreamClientManager {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<Connection>>();
  private readonly now: () => number;
  private readonly clientFactory: () => DownstreamClient;
  private readonly transportFactory: (spec: ToolLaunchSpec) => Transport;
  private reaper: NodeJS.Timeout | undefined;

  constructor(private readonly options: DownstreamClientManagerOptions) {
    this.now = options.now ?? Date.now;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  /** List every tool the downstream server exposes (follows pagination). */
  async listTools(toolId: string): Promise<DownstreamTool[]> {
    return this.withConnection(toolId, async (conn, spec) => {
      const tools: DownstreamTool[] = [];
      let cursor: string | undefined;
      // Bounded to avoid a misbehaving server paging forever.
      for (let page = 0; page < 50; page++) {
        const result = await conn.client.listTools(cursor !== undefined ? { cursor } : undefined, {
          timeout: spec.timeoutMs,
        });
        tools.push(...result.tools);
        if (result.nextCursor === undefined || result.nextCursor === '') break;
        cursor = result.nextCursor;
      }
      conn.tools = tools;
      return tools;
    });
  }

  /** Look up one downstream tool's definition (uses the cached list). */
  async describeTool(toolId: string, name: string): Promise<DownstreamTool | undefined> {
    const cached = this.connections.get(toolId)?.tools;
    const tools = cached ?? (await this.listTools(toolId));
    return tools.find((t) => t.name === name);
  }

  /** Invoke a downstream tool and return its result unchanged. */
  async callTool(
    toolId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const start = this.now();
    try {
      const result = await this.withConnection(toolId, async (conn, spec) =>
        conn.client.callTool({ name, arguments: args }, undefined, {
          timeout: spec.timeoutMs,
          resetTimeoutOnProgress: true,
        }),
      );
      metrics.increment('downstream_tool_calls_total', { toolId, outcome: 'ok' });
      return normalizeCallResult(result);
    } catch (err) {
      metrics.increment('downstream_tool_calls_total', { toolId, outcome: 'error' });
      throw err;
    } finally {
      metrics.histogram('downstream_tool_call_duration_ms', this.now() - start);
    }
  }

  isConnected(toolId: string): boolean {
    return this.connections.has(toolId);
  }

  connectedToolIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /** Close the connection (and child process) for one tool, if open. */
  async close(toolId: string): Promise<void> {
    const conn = this.connections.get(toolId);
    if (!conn) return;
    this.connections.delete(toolId);
    await this.safeClose(conn);
  }

  async closeAll(): Promise<void> {
    this.stopReaper();
    const all = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(all.map((c) => this.safeClose(c)));
  }

  startReaper(): void {
    if (this.reaper) return;
    const interval = Math.min(60_000, Math.max(1_000, Math.floor(this.options.idleTimeoutMs / 2)));
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, interval);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }

  /** Close connections idle for longer than DOWNSTREAM_IDLE_TIMEOUT_MS. */
  async reapIdle(): Promise<number> {
    const cutoff = this.now() - this.options.idleTimeoutMs;
    const idle = Array.from(this.connections.values()).filter(
      (c) => c.inFlight === 0 && c.lastUsedAt < cutoff,
    );
    for (const c of idle) this.connections.delete(c.toolId);
    await Promise.allSettled(idle.map((c) => this.safeClose(c)));
    for (const c of idle) logger.info('Closed idle downstream connection', { toolId: c.toolId });
    return idle.length;
  }

  private async withConnection<T>(
    toolId: string,
    fn: (conn: Connection, spec: ToolLaunchSpec) => Promise<T>,
  ): Promise<T> {
    const spec = this.options.resolveLaunchSpec(toolId);
    if (!spec) {
      throw new DownstreamError(
        'NOT_REGISTERED',
        `Tool not registered or has no launch command: ${toolId}. Use install_tool first.`,
      );
    }
    const conn = await this.getConnection(toolId, spec);
    conn.inFlight++;
    conn.lastUsedAt = this.now();
    try {
      return await fn(conn, spec);
    } finally {
      conn.inFlight--;
      conn.lastUsedAt = this.now();
    }
  }

  private async getConnection(toolId: string, spec: ToolLaunchSpec): Promise<Connection> {
    const existing = this.connections.get(toolId);
    if (existing) return existing;

    const inProgress = this.pending.get(toolId);
    if (inProgress) return inProgress;

    const connecting = this.connect(toolId, spec).finally(() => {
      this.pending.delete(toolId);
    });
    this.pending.set(toolId, connecting);
    return connecting;
  }

  private async connect(toolId: string, spec: ToolLaunchSpec): Promise<Connection> {
    const started = this.now();
    logger.info('Starting downstream MCP server', {
      toolId,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      envKeys: Object.keys(spec.env),
    });

    const client = this.clientFactory();
    let transport: Transport;
    try {
      transport = this.transportFactory(spec);
    } catch (err) {
      throw describeLaunchError(spec, err);
    }

    let launchError: unknown;
    transport.onerror = (err: Error): void => {
      launchError ??= err;
      logger.warn('Downstream transport error', { toolId, err: err.message });
    };

    try {
      await client.connect(transport, { timeout: this.options.connectTimeoutMs });
    } catch (err) {
      await client.close().catch(() => undefined);
      metrics.increment('downstream_connect_failures_total', { toolId });
      throw describeLaunchError(spec, launchError ?? err);
    }

    const conn: Connection = { toolId, client, lastUsedAt: this.now(), inFlight: 0 };
    client.onclose = (): void => {
      if (this.connections.get(toolId) === conn) {
        this.connections.delete(toolId);
        logger.info('Downstream MCP server exited', { toolId });
      }
    };
    this.connections.set(toolId, conn);
    metrics.gauge('downstream_connections_active', this.connections.size);
    logger.info('Downstream MCP server connected', { toolId, durationMs: this.now() - started });
    return conn;
  }

  private async safeClose(conn: Connection): Promise<void> {
    try {
      await conn.client.close();
    } catch (err) {
      logger.warn('Error closing downstream connection', {
        toolId: conn.toolId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    metrics.gauge('downstream_connections_active', this.connections.size);
  }
}

let shared: DownstreamClientManager | undefined;

/**
 * Process-wide manager: every MCP session (stdio or HTTP) shares one
 * connection per installed tool.
 */
export function getDownstreamClients(): DownstreamClientManager {
  shared ??= new DownstreamClientManager({
    resolveLaunchSpec: (toolId): ToolLaunchSpec | undefined => runtimeRegistrar.getLaunchSpec(toolId),
    idleTimeoutMs: config.DOWNSTREAM_IDLE_TIMEOUT_MS,
    connectTimeoutMs: config.DOWNSTREAM_CONNECT_TIMEOUT_MS,
  });
  return shared;
}

/** Close and forget the shared manager (shutdown hook; tests). */
export async function closeDownstreamClients(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.closeAll();
}
