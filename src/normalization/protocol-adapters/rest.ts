/**
 * src/normalization/protocol-adapters/rest.ts
 * Normalizes HTTP REST requests to the internal NormalizedRequest format.
 */

import { randomUUID } from 'crypto';
import type { IProtocolAdapter, NormalizedRequest, NormalizedResult } from '../../types/index';

interface RestRawRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
}

export class RestProtocolAdapter implements IProtocolAdapter {
  readonly protocol = 'rest';

  normalize(raw: unknown): NormalizedRequest {
    const r = raw as Partial<RestRawRequest>;
    if (!r || typeof r.method !== 'string' || typeof r.path !== 'string') {
      throw new Error('Invalid REST request: missing required fields (method, path)');
    }
    return {
      id: randomUUID(),
      method: `${r.method.toUpperCase()} ${r.path}`,
      params: {
        query: r.query ?? {},
        body: r.body ?? {},
        headers: r.headers ?? {},
      },
      protocol: this.protocol,
      version: '1.1',
      requestedAt: new Date(),
      requestId: randomUUID(),
      metadata: {
        httpMethod: r.method.toUpperCase(),
        path: r.path,
        ip: r.ip,
      },
    };
  }

  denormalize(result: NormalizedResult): unknown {
    if (!result.success) {
      return {
        error: result.error?.message ?? 'Internal Server Error',
        code: result.error?.code,
        details: result.error?.details,
      };
    }
    return result.data;
  }
}

export const restAdapter = new RestProtocolAdapter();
