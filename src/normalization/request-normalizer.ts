import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';

const logger = createLogger('request-normalizer');

export interface NormalizedRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  clientType: string;
  timestamp: Date;
  traceId?: string;
}

const JSONRPC_VERSION = '2.0';

const CLIENT_HINTS: Record<string, string> = {
  'claude-desktop': 'claude-desktop',
  'vscode': 'vscode',
  'cursor': 'cursor',
  'continue': 'continue',
  'rest': 'rest',
  'http': 'rest',
  'jsonrpc': 'jsonrpc',
  'mcp': 'jsonrpc',
};

function detectClientType(raw: unknown, hint?: string): string {
  if (hint) {
    const lower = hint.toLowerCase();
    for (const [key, value] of Object.entries(CLIENT_HINTS)) {
      if (lower.includes(key)) return value;
    }
    return hint;
  }

  if (typeof raw !== 'object' || raw === null) return 'unknown';

  const obj = raw as Record<string, unknown>;

  if (obj['jsonrpc'] === JSONRPC_VERSION && typeof obj['method'] === 'string') {
    return 'jsonrpc';
  }

  if (typeof obj['method'] === 'string' && (obj['path'] ?? obj['url'])) {
    return 'rest';
  }

  if (typeof obj['intent'] === 'string' || typeof obj['query'] === 'string') {
    return 'natural-language';
  }

  return 'unknown';
}

function extractParams(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') return { value: raw };

  const obj = raw as Record<string, unknown>;

  const params = obj['params'];
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }

  if (Array.isArray(params)) {
    return params.reduce<Record<string, unknown>>((acc, item, idx) => {
      acc[String(idx)] = item;
      return acc;
    }, {});
  }

  // REST-style: merge body + query string params
  const body = obj['body'];
  const query = obj['query'];

  let merged: Record<string, unknown> = {};

  if (typeof body === 'object' && body !== null) {
    merged = { ...merged, ...(body as Record<string, unknown>) };
  }

  if (typeof query === 'object' && query !== null) {
    merged = { ...merged, ...(query as Record<string, unknown>) };
  }

  // Natural-language: extract intent/query
  if (typeof obj['intent'] === 'string' || typeof obj['query'] === 'string') {
    merged['_query'] = obj['intent'] ?? obj['query'];
  }

  return merged;
}

function extractMethod(raw: unknown, clientType: string): string {
  if (typeof raw !== 'object' || raw === null) return 'unknown';

  const obj = raw as Record<string, unknown>;

  if (typeof obj['method'] === 'string') {
    return obj['method'];
  }

  if (clientType === 'rest') {
    const httpMethod = typeof obj['httpMethod'] === 'string' ? obj['httpMethod'] : 'GET';
    const pathStr =
      typeof obj['path'] === 'string'
        ? obj['path']
        : typeof obj['url'] === 'string'
          ? obj['url']
          : '';

    const cleanPath = pathStr.replace(/^\/+/, '').replace(/[?#].*$/, '');
    return cleanPath ? `${httpMethod.toUpperCase()}:${cleanPath}` : httpMethod.toUpperCase();
  }

  if (clientType === 'natural-language') {
    return 'nl:query';
  }

  return 'unknown';
}

function extractTraceId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  const headers = obj['headers'];
  if (typeof headers === 'object' && headers !== null) {
    const h = headers as Record<string, unknown>;
    const traceId =
      h['x-trace-id'] ?? h['x-request-id'] ?? h['traceparent'] ?? h['X-Trace-Id'];
    if (typeof traceId === 'string') return traceId;
  }

  const traceId = obj['traceId'] ?? obj['trace_id'] ?? obj['requestId'];
  if (typeof traceId === 'string') return traceId;

  return undefined;
}

function extractId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return randomUUID();
  const obj = raw as Record<string, unknown>;

  const id = obj['id'];
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return String(id);

  return randomUUID();
}

function normalizeForClient(result: unknown, clientType: string, requestId?: string | null): unknown {
  if (clientType === 'jsonrpc') {
    return {
      jsonrpc: JSONRPC_VERSION,
      result,
      id: requestId ?? null,
    };
  }

  if (clientType === 'rest') {
    return {
      data: result,
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  if (clientType === 'natural-language') {
    if (typeof result === 'string') return result;
    return JSON.stringify(result, null, 2);
  }

  return result;
}

export class RequestNormalizer {
  normalize(raw: unknown, clientHint?: string): NormalizedRequest {
    const clientType = detectClientType(raw, clientHint);

    const traceId = extractTraceId(raw);
    const normalized: NormalizedRequest = {
      id: extractId(raw),
      method: extractMethod(raw, clientType),
      params: extractParams(raw),
      clientType,
      timestamp: new Date(),
      ...(traceId !== undefined ? { traceId } : {}),
    };

    logger.debug('Request normalized', {
      id: normalized.id,
      method: normalized.method,
      clientType: normalized.clientType,
      paramKeys: Object.keys(normalized.params),
    });

    return normalized;
  }

  /**
   * Formats a result value for the given client protocol.
   * Pass the originating `NormalizedRequest` (or just its `id` string) so that
   * JSON-RPC responses carry the correct request `id`.
   */
  denormalize(
    result: unknown,
    clientType: string,
    requestOrId?: NormalizedRequest | string,
  ): unknown {
    const requestId =
      typeof requestOrId === 'string'
        ? requestOrId
        : requestOrId?.id ?? null;

    const output = normalizeForClient(result, clientType, requestId);

    logger.debug('Response denormalized', {
      clientType,
      hasResult: result !== null && result !== undefined,
    });

    return output;
  }
}

export const requestNormalizer = new RequestNormalizer();
