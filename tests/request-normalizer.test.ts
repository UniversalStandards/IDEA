/**
 * Tests for the request normalizer.
 */
import { RequestNormalizer } from '../src/normalization/request-normalizer';

describe('RequestNormalizer', () => {
  let normalizer: RequestNormalizer;

  beforeEach(() => {
    normalizer = new RequestNormalizer();
  });

  describe('normalize', () => {
    it('handles a JSON-RPC 2.0 request', () => {
      const raw = {
        jsonrpc: '2.0',
        id: '42',
        method: 'tools/list',
        params: { cursor: 'abc' },
      };
      const result = normalizer.normalize(raw);
      expect(result.method).toEqual('tools/list');
      expect(result.params).toMatchObject({ cursor: 'abc' });
      expect(result.clientType).toEqual('jsonrpc');
      expect(result.id).toEqual('42');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('handles a REST-style request', () => {
      const raw = {
        method: 'GET',
        path: '/api/v1/tools',
        query: { limit: '10' },
      };
      const result = normalizer.normalize(raw, 'rest');
      expect(result.clientType).toEqual('rest');
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('method');
    });

    it('handles a natural-language style request', () => {
      const raw = { intent: 'list all tools', query: 'show tools' };
      const result = normalizer.normalize(raw);
      expect(result).toHaveProperty('method');
      expect(result).toHaveProperty('params');
    });

    it('always returns a valid NormalizedRequest shape', () => {
      const cases: unknown[] = [
        null,
        {},
        'just a string',
        42,
        { method: 'ping' },
        { jsonrpc: '2.0', method: 'test', params: null },
      ];
      for (const raw of cases) {
        const result = normalizer.normalize(raw);
        expect(typeof result.id).toEqual('string');
        expect(typeof result.method).toEqual('string');
        expect(typeof result.clientType).toEqual('string');
        expect(result.timestamp).toBeInstanceOf(Date);
        expect(typeof result.params).toEqual('object');
      }
    });
  });

  describe('denormalize', () => {
    it('returns a serializable object for jsonrpc client', () => {
      const result = normalizer.denormalize({ data: [1, 2, 3] }, 'jsonrpc');
      expect(result).toBeDefined();
    });

    it('returns the result for unknown client type', () => {
      const data = { items: ['a', 'b'] };
      const result = normalizer.denormalize(data, 'unknown');
      expect(result).toBeDefined();
    });

    it('returns rest-style wrapper for rest client', () => {
      const result = normalizer.denormalize({ items: [] }, 'rest') as Record<string, unknown>;
      expect(result['status']).toBe('ok');
      expect(result['data']).toEqual({ items: [] });
      expect(typeof result['timestamp']).toBe('string');
    });

    it('returns string for natural-language client with string result', () => {
      const result = normalizer.denormalize('Here are the tools', 'natural-language');
      expect(result).toBe('Here are the tools');
    });

    it('JSON-stringifies non-string result for natural-language client', () => {
      const result = normalizer.denormalize({ count: 5 }, 'natural-language');
      expect(typeof result).toBe('string');
      expect((result as string)).toContain('count');
    });

    it('jsonrpc response includes requestId from NormalizedRequest', () => {
      const req = normalizer.normalize({ jsonrpc: '2.0', id: 'req-99', method: 'ping', params: {} });
      const result = normalizer.denormalize({ ok: true }, 'jsonrpc', req) as Record<string, unknown>;
      expect(result['id']).toBe('req-99');
    });

    it('jsonrpc response includes requestId from string argument', () => {
      const result = normalizer.denormalize({ ok: true }, 'jsonrpc', 'id-42') as Record<string, unknown>;
      expect(result['id']).toBe('id-42');
    });

    it('jsonrpc response has null id when no requestOrId provided', () => {
      const result = normalizer.denormalize({ ok: true }, 'jsonrpc') as Record<string, unknown>;
      expect(result['id']).toBeNull();
    });
  });

  describe('normalize — traceId extraction', () => {
    it('extracts x-trace-id from headers', () => {
      const raw = { jsonrpc: '2.0', method: 'ping', headers: { 'x-trace-id': 'trace-abc' } };
      const result = normalizer.normalize(raw);
      expect(result.traceId).toBe('trace-abc');
    });

    it('extracts x-request-id from headers', () => {
      const raw = { jsonrpc: '2.0', method: 'ping', headers: { 'x-request-id': 'req-id-xyz' } };
      const result = normalizer.normalize(raw);
      expect(result.traceId).toBe('req-id-xyz');
    });

    it('extracts traceId from top-level field', () => {
      const raw = { jsonrpc: '2.0', method: 'ping', traceId: 'top-level-trace' };
      const result = normalizer.normalize(raw);
      expect(result.traceId).toBe('top-level-trace');
    });

    it('extracts trace_id from top-level field', () => {
      const raw = { method: 'ping', trace_id: 'underscore-trace' };
      const result = normalizer.normalize(raw);
      expect(result.traceId).toBe('underscore-trace');
    });

    it('does not set traceId when no trace header or field present', () => {
      const raw = { jsonrpc: '2.0', method: 'ping' };
      const result = normalizer.normalize(raw);
      expect(result.traceId).toBeUndefined();
    });
  });

  describe('normalize — clientHint detection', () => {
    it('detects claude-desktop from hint', () => {
      const result = normalizer.normalize({}, 'Claude-Desktop');
      expect(result.clientType).toBe('claude-desktop');
    });

    it('detects vscode from hint', () => {
      const result = normalizer.normalize({}, 'vscode-extension');
      expect(result.clientType).toBe('vscode');
    });

    it('detects cursor from hint', () => {
      const result = normalizer.normalize({}, 'cursor-editor');
      expect(result.clientType).toBe('cursor');
    });

    it('uses hint verbatim when no known pattern matches', () => {
      const result = normalizer.normalize({}, 'custom-client-v2');
      expect(result.clientType).toBe('custom-client-v2');
    });

    it('detects jsonrpc from hint', () => {
      const result = normalizer.normalize({}, 'mcp-client');
      expect(result.clientType).toBe('jsonrpc');
    });
  });

  describe('normalize — method extraction', () => {
    it('returns unknown method for non-object input', () => {
      const result = normalizer.normalize(42);
      expect(result.method).toBe('unknown');
    });

    it('extracts REST method from httpMethod+path', () => {
      const raw = { path: '/tools', url: undefined, httpMethod: 'POST' };
      const result = normalizer.normalize(raw, 'rest');
      expect(result.method).toContain('POST');
    });

    it('falls back to GET when no httpMethod', () => {
      const raw = { url: '/api/v1/tools' };
      const result = normalizer.normalize(raw, 'rest');
      expect(result.method).toContain('GET');
    });

    it('extracts nl:query for natural-language client', () => {
      const raw = { intent: 'list tools' };
      const result = normalizer.normalize(raw);
      expect(result.method).toBe('nl:query');
    });

    it('returns unknown when no method field and not rest/nl', () => {
      const raw = { data: 'something' };
      const result = normalizer.normalize(raw);
      expect(result.method).toBe('unknown');
    });
  });

  describe('normalize — params extraction', () => {
    it('extracts array params as indexed object', () => {
      const raw = { jsonrpc: '2.0', method: 'test', params: ['a', 'b', 'c'] };
      const result = normalizer.normalize(raw);
      expect(result.params['0']).toBe('a');
      expect(result.params['1']).toBe('b');
      expect(result.params['2']).toBe('c');
    });

    it('merges body and query for REST requests', () => {
      const raw = {
        method: 'POST',
        body: { name: 'Alice' },
        query: { format: 'json' },
      };
      const result = normalizer.normalize(raw, 'rest');
      expect(result.params['name']).toBe('Alice');
      expect(result.params['format']).toBe('json');
    });

    it('includes _query for natural-language requests', () => {
      const raw = { intent: 'list all tools' };
      const result = normalizer.normalize(raw);
      expect(result.params['_query']).toBe('list all tools');
    });

    it('returns { value: raw } for primitive input', () => {
      const result = normalizer.normalize(42);
      expect(result.params['value']).toBe(42);
    });
  });

  describe('normalize — id extraction', () => {
    it('uses numeric id converted to string', () => {
      const raw = { jsonrpc: '2.0', method: 'ping', id: 42 };
      const result = normalizer.normalize(raw);
      expect(result.id).toBe('42');
    });

    it('generates UUID when no id present', () => {
      const raw = { jsonrpc: '2.0', method: 'ping' };
      const result = normalizer.normalize(raw);
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });
  });
});
