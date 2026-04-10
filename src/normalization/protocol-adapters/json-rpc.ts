/**
 * src/normalization/protocol-adapters/json-rpc.ts
 * Normalizes JSON-RPC 2.0 requests to the internal NormalizedRequest format.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { IProtocolAdapter, NormalizedRequest, NormalizedResult } from '../../types/index';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
});

export class JsonRpcProtocolAdapter implements IProtocolAdapter {
  readonly protocol = 'json-rpc';

  normalize(raw: unknown): NormalizedRequest {
    const parsed = JsonRpcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid JSON-RPC 2.0 request: ${parsed.error.message}`);
    }
    const { method, params, id } = parsed.data;
    const normalizedParams: Record<string, unknown> = Array.isArray(params)
      ? { args: params }
      : (params ?? {});

    return {
      id: String(id ?? randomUUID()),
      method,
      params: normalizedParams,
      protocol: this.protocol,
      version: '2.0',
      requestedAt: new Date(),
      requestId: randomUUID(),
      metadata: { originalId: id },
    };
  }

  denormalize(result: NormalizedResult): unknown {
    if (!result.success) {
      return {
        jsonrpc: '2.0',
        error: {
          code: result.error?.code ? parseInt(result.error.code, 10) : -32000,
          message: result.error?.message ?? 'Internal error',
          data: result.error?.details,
        },
        id: result.requestId,
      };
    }
    return {
      jsonrpc: '2.0',
      result: result.data,
      id: result.requestId,
    };
  }
}

export const jsonRpcAdapter = new JsonRpcProtocolAdapter();
