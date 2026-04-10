/**
 * src/normalization/protocol-adapters/mcp.ts
 * Normalizes MCP (Model Context Protocol) requests to the internal NormalizedRequest format.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { IProtocolAdapter, NormalizedRequest, NormalizedResult } from '../../types/index';

const McpRequestSchema = z.object({
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  _meta: z.record(z.unknown()).optional(),
  // MCP 1.x protocol version field
  protocolVersion: z.string().optional(),
});

export class McpProtocolAdapter implements IProtocolAdapter {
  readonly protocol = 'mcp';

  normalize(raw: unknown): NormalizedRequest {
    const parsed = McpRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid MCP request: ${parsed.error.message}`);
    }
    const { method, params, _meta, protocolVersion } = parsed.data;

    return {
      id: randomUUID(),
      method,
      params: params ?? {},
      protocol: this.protocol,
      version: protocolVersion ?? '1.0',
      requestedAt: new Date(),
      requestId: randomUUID(),
      metadata: _meta ?? {},
    };
  }

  denormalize(result: NormalizedResult): unknown {
    if (!result.success) {
      return {
        error: {
          code: -1,
          message: result.error?.message ?? 'Unknown error',
          data: result.error?.details,
        },
      };
    }
    return { result: result.data };
  }
}

export const mcpProtocolAdapter = new McpProtocolAdapter();
