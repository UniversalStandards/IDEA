/**
 * src/adapters/mcp/define-tool.ts
 *
 * Type-safe, compiler-cheap wrapper around `McpServer.registerTool()`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP SDK's `McpServer.tool()` / `McpServer.registerTool()` signatures are
 * generic over a union of Zod v3 and Zod v4 schema shapes (`ZodRawShapeCompat |
 * AnySchema`). Inferring a handler's `args` type through that union forces the
 * TypeScript checker into an effectively unbounded instantiation chain:
 *
 *   - one tool registration costs ~30 s and ~5 M type instantiations;
 *   - the failure surfaces as TS2589 ("Type instantiation is excessively deep
 *     and possibly infinite"), and with several tools in one file `tsc` runs
 *     for minutes and is OOM-killed on a typical CI runner (exit 134/137).
 *
 * This helper keeps the exact same runtime behaviour (it forwards to
 * `registerTool`, so the SDK still validates input against the Zod shape and
 * passes the parsed value to the handler) but infers the handler's `args` type
 * from the Zod v3 API directly (`z.infer<z.ZodObject<S>>`), which compiles in
 * milliseconds. Handler authors keep full type safety on `args`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/** A Zod "raw shape": the object literal passed to `z.object({...})`. */
export type ToolInputShape = z.ZodRawShape;

/** The parsed (validated) arguments a tool handler receives. */
export type ToolArgs<S extends ToolInputShape> = z.infer<z.ZodObject<S>>;

/** A tool handler: receives validated args and returns an MCP tool result. */
export type ToolHandler<S extends ToolInputShape> = (
  args: ToolArgs<S>,
) => Promise<CallToolResult>;

/**
 * Minimal structural view of `McpServer.registerTool` used for the single,
 * contained cast below. Declared locally so the SDK's expensive generic
 * signature is never instantiated.
 */
interface ToolRegistrar {
  registerTool(
    name: string,
    config: { description: string; inputSchema: ToolInputShape },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ): unknown;
}

/**
 * Register a tool on an `McpServer`.
 *
 * @param server       The MCP server instance to register on.
 * @param name         Unique tool name exposed to MCP clients.
 * @param description  Human-readable description exposed to MCP clients.
 * @param inputSchema  Zod raw shape describing the tool's input arguments
 *                     (use `{}` for tools that take no arguments).
 * @param handler      Async handler receiving the validated, typed arguments.
 */
export function defineTool<S extends ToolInputShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: ToolHandler<S>,
): void {
  // Single, intentional cast through `unknown`: see the module header. The SDK
  // has already validated `args` against `inputSchema` before invoking `cb`.
  (server as unknown as ToolRegistrar).registerTool(
    name,
    { description, inputSchema },
    (args) => handler(args as ToolArgs<S>),
  );
}
