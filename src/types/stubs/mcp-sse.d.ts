/**
 * Minimal type stub for @modelcontextprotocol/sdk/server/sse.js
 * See mcp-server.d.ts for rationale.
 */
import type { McpTransport } from './mcp-server';

/** Transport that uses Server-Sent Events over HTTP */
export declare class SSEServerTransport implements McpTransport {
  readonly type: 'sse';
  constructor(path: string, res: unknown);
}
