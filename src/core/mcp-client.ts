/**
 * src/core/mcp-client.ts
 * MCP client-side transport: connects to a running tool process over stdio
 * and allows the hub to call tools, list capabilities, and close the connection.
 *
 * Uses @modelcontextprotocol/sdk Client + StdioClientTransport.
 * Each RegisteredTool that is running gets its own ToolClient instance,
 * managed by the ToolClientPool singleton.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { type RegisteredTool } from '../provisioning/runtime-registrar';
import packageJson from '../../package.json';

const logger = createLogger('mcp-client');

export interface ToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages a single MCP Client connection to one running tool process.
 * The connection is established lazily on first use and re-established
 * if the process restarts.
 */
export class ToolClient {
  private client: Client | null = null;
  private connected = false;

  constructor(private readonly registered: RegisteredTool) {}

  get toolId(): string {
    return this.registered.tool.id;
  }

  /**
   * Ensure a live Client connection exists. Creates a new StdioClientTransport
   * (which spawns the process) if none is active.
   */
  private async ensureConnected(): Promise<Client> {
    if (this.client && this.connected) return this.client;

    const tool = this.registered.tool;
    const cfg = this.registered.config;

    // Resolve command + args in the same way runtime-registrar does
    const command = this.resolveCommand();
    if (!command) {
      throw new Error(`Cannot resolve start command for MCP client: ${tool.id}`);
    }

    logger.debug('Establishing MCP client connection', {
      toolId: tool.id,
      cmd: command.cmd,
      args: command.args,
    });

    const transport = new StdioClientTransport({
      command: command.cmd,
      args: command.args,
      env: { ...process.env, ...cfg.env } as Record<string, string>,
      cwd: cfg.workingDir,
      stderr: 'pipe',
    });

    const newClient = new Client({ name: 'IDEA Hub', version: packageJson.version });

    await newClient.connect(transport);
    this.client = newClient;
    this.connected = true;

    logger.info('MCP client connected', { toolId: tool.id });
    metrics.increment('mcp_client_connections_total', { toolId: tool.id });

    return newClient;
  }

  /**
   * Call a named tool on the connected MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolCallResult> {
    const start = Date.now();
    const client = await this.ensureConnected();

    try {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
      );

      const durationMs = Date.now() - start;
      metrics.histogram('mcp_client_call_duration_ms', durationMs, { toolId: this.toolId, tool: name });
      metrics.increment('mcp_client_calls_total', { toolId: this.toolId, success: 'true' });

      logger.debug('MCP tool call succeeded', { toolId: this.toolId, tool: name, durationMs });
      return result as ToolCallResult;
    } catch (err) {
      const durationMs = Date.now() - start;
      metrics.increment('mcp_client_calls_total', { toolId: this.toolId, success: 'false' });
      metrics.histogram('mcp_client_call_duration_ms', durationMs, { toolId: this.toolId, tool: name });

      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('MCP tool call failed', { toolId: this.toolId, tool: name, err: msg });

      // Mark as disconnected so next call attempts reconnect
      this.connected = false;
      this.client = null;
      throw err;
    }
  }

  /**
   * List tools exposed by the connected MCP server.
   */
  async listTools(): Promise<ToolInfo[]> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /**
   * Close the client connection cleanly.
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        logger.warn('Error closing MCP client', {
          toolId: this.toolId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.client = null;
      this.connected = false;
      logger.debug('MCP client closed', { toolId: this.toolId });
      metrics.increment('mcp_client_disconnections_total', { toolId: this.toolId });
    }
  }

  private resolveCommand(): { cmd: string; args: string[] } | null {
    const { tool, config: cfg } = this.registered;

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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Singleton pool: one ToolClient per registered tool.
 * Lifecycle:
 *  - `acquire(registered)` — returns (and caches) a ToolClient for the tool
 *  - `release(toolId)`     — closes and removes the client
 *  - `closeAll()`          — shuts down all open clients (called on server stop)
 */
export class ToolClientPool {
  private readonly pool = new Map<string, ToolClient>();

  acquire(registered: RegisteredTool): ToolClient {
    const existing = this.pool.get(registered.tool.id);
    if (existing) return existing;

    const client = new ToolClient(registered);
    this.pool.set(registered.tool.id, client);
    return client;
  }

  get(toolId: string): ToolClient | undefined {
    return this.pool.get(toolId);
  }

  async release(toolId: string): Promise<void> {
    const client = this.pool.get(toolId);
    if (client) {
      await client.close();
      this.pool.delete(toolId);
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.pool.keys());
    await Promise.allSettled(ids.map((id) => this.release(id)));
    logger.info('All MCP client connections closed', { count: ids.length });
  }
}

export const toolClientPool = new ToolClientPool();
