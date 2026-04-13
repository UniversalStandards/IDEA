/**
 * Minimal type stub for @modelcontextprotocol/sdk/server/mcp.js
 *
 * The real package includes a 382KB Zod v4 types.d.ts that causes tsc to hang
 * due to complex recursive conditional types in the Zod v4 / Zod v3 compatibility
 * layer. This stub provides only the surface our code actually uses, allowing
 * type checking to complete in a reasonable time.
 *
 * Runtime: the real package is used — only this stub is consulted by tsc.
 */

/** Transport that can be passed to McpServer.connect() */
export interface McpTransport {
  readonly type?: string;
}

/** Options passed to the McpServer constructor */
export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
}

/**
 * High-level MCP server class (stubbed).
 * Only the methods our codebase calls are declared here.
 */
export declare class McpServer {
  constructor(options: McpServerOptions);

  /** Register a tool handler */
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void;

  /** Register a resource handler */
  resource(
    name: string,
    template: unknown,
    handler: (...args: unknown[]) => Promise<unknown> | unknown,
  ): void;

  /** Register a prompt handler */
  prompt(
    name: string,
    args: unknown,
    handler: (...args: unknown[]) => Promise<unknown> | unknown,
  ): void;

  /** Connect to a transport */
  connect(transport: McpTransport): Promise<void>;

  /** Close the server and release resources */
  close(): Promise<void>;
}
