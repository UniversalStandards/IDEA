/**
 * Minimal type stub for @modelcontextprotocol/sdk/server/stdio.js
 * See mcp-server.d.ts for rationale.
 */
import type { McpTransport } from './mcp-server';

/** Transport that reads from stdin and writes to stdout */
export declare class StdioServerTransport implements McpTransport {
  readonly type: 'stdio';
  constructor();
}
