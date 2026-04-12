/**
 * tests/protocol-adapters.test.ts
 * Unit tests for all four protocol adapters:
 * json-rpc, rest, graphql (protocol), mcp
 */

import { JsonRpcProtocolAdapter } from '../src/normalization/protocol-adapters/json-rpc';
import { RestProtocolAdapter } from '../src/normalization/protocol-adapters/rest';
import { GraphQLProtocolAdapter } from '../src/normalization/protocol-adapters/graphql';
import { McpProtocolAdapter } from '../src/normalization/protocol-adapters/mcp';
import type { NormalizedResult } from '../src/types/index';

const mockResult = (success: boolean): NormalizedResult => ({
  requestId: 'test-request-id',
  success,
  ...(success ? { data: { value: 42 } } : {}),
  ...(!success ? { error: { code: 'ERR', message: 'fail', retryable: false } } : {}),
  durationMs: 10,
  respondedAt: new Date(),
  metadata: {},
});

describe('JsonRpcProtocolAdapter', () => {
  const adapter = new JsonRpcProtocolAdapter();

  it('normalizes a valid JSON-RPC 2.0 request with object params', () => {
    const raw = { jsonrpc: '2.0', method: 'tools/list', params: { cursor: 'abc' }, id: 1 };
    const req = adapter.normalize(raw);
    expect(req.method).toBe('tools/list');
    expect(req.params['cursor']).toBe('abc');
    expect(req.protocol).toBe('json-rpc');
    expect(req.version).toBe('2.0');
  });

  it('normalizes array params by wrapping in { args }', () => {
    const raw = { jsonrpc: '2.0', method: 'echo', params: ['a', 'b'], id: '2' };
    const req = adapter.normalize(raw);
    expect(req.params['args']).toEqual(['a', 'b']);
  });

  it('throws for invalid JSON-RPC (missing jsonrpc field)', () => {
    expect(() => adapter.normalize({ method: 'test' })).toThrow('Invalid JSON-RPC 2.0 request');
  });

  it('denormalizes a success result to JSON-RPC response', () => {
    const res = adapter.denormalize(mockResult(true)) as Record<string, unknown>;
    expect(res['jsonrpc']).toBe('2.0');
    expect(res['result']).toEqual({ value: 42 });
    expect(res['error']).toBeUndefined();
  });

  it('denormalizes an error result to JSON-RPC error response', () => {
    const res = adapter.denormalize(mockResult(false)) as Record<string, unknown>;
    expect(res['error']).toBeDefined();
    expect(res['result']).toBeUndefined();
  });
});

describe('RestProtocolAdapter', () => {
  const adapter = new RestProtocolAdapter();

  it('normalizes a GET request', () => {
    const raw = { method: 'get', path: '/tools', query: { limit: '10' } };
    const req = adapter.normalize(raw);
    expect(req.method).toBe('GET /tools');
    expect((req.params['query'] as Record<string, unknown>)['limit']).toBe('10');
    expect(req.protocol).toBe('rest');
  });

  it('normalizes a POST request with body', () => {
    const raw = { method: 'post', path: '/tools/install', body: { name: 'my-tool' } };
    const req = adapter.normalize(raw);
    expect(req.method).toBe('POST /tools/install');
    expect((req.params['body'] as Record<string, unknown>)['name']).toBe('my-tool');
  });

  it('throws for missing method or path', () => {
    expect(() => adapter.normalize({ path: '/test' })).toThrow('Invalid REST request');
    expect(() => adapter.normalize({ method: 'GET' })).toThrow('Invalid REST request');
  });

  it('denormalizes success result to raw data', () => {
    const res = adapter.denormalize(mockResult(true));
    expect(res).toEqual({ value: 42 });
  });

  it('denormalizes error result to error object', () => {
    const res = adapter.denormalize(mockResult(false)) as Record<string, unknown>;
    expect(res['error']).toBe('fail');
  });
});

describe('GraphQLProtocolAdapter', () => {
  const adapter = new GraphQLProtocolAdapter();

  it('normalizes a query operation', () => {
    const raw = { query: '{ tools { id name } }', operationName: 'GetTools' };
    const req = adapter.normalize(raw);
    expect(req.method).toBe('GetTools');
    expect(req.params['query']).toBe('{ tools { id name } }');
    expect(req.protocol).toBe('graphql');
  });

  it('detects mutation operation type', () => {
    const raw = { query: 'mutation InstallTool($id: ID!) { install(id: $id) { success } }' };
    const req = adapter.normalize(raw);
    expect(req.metadata['operationType']).toBe('mutation');
  });

  it('detects subscription operation type', () => {
    const raw = { query: 'subscription OnEvent { event { type } }' };
    const req = adapter.normalize(raw);
    expect(req.metadata['operationType']).toBe('subscription');
  });

  it('throws for missing query field', () => {
    expect(() => adapter.normalize({ variables: {} })).toThrow('Invalid GraphQL request');
  });

  it('denormalizes success result to { data }', () => {
    const res = adapter.denormalize(mockResult(true)) as Record<string, unknown>;
    expect(res['data']).toEqual({ value: 42 });
  });

  it('denormalizes error to { data: null, errors: [...] }', () => {
    const res = adapter.denormalize(mockResult(false)) as Record<string, unknown>;
    expect(res['data']).toBeNull();
    expect(Array.isArray(res['errors'])).toBe(true);
  });
});

describe('McpProtocolAdapter', () => {
  const adapter = new McpProtocolAdapter();

  it('normalizes a standard MCP request', () => {
    const raw = { method: 'tools/call', params: { name: 'my-tool', arguments: {} } };
    const req = adapter.normalize(raw);
    expect(req.method).toBe('tools/call');
    expect(req.protocol).toBe('mcp');
  });

  it('includes _meta fields in metadata', () => {
    const raw = { method: 'tools/list', _meta: { progressToken: 'abc' } };
    const req = adapter.normalize(raw);
    expect(req.metadata['progressToken']).toBe('abc');
  });

  it('throws for missing method', () => {
    expect(() => adapter.normalize({ params: {} })).toThrow('Invalid MCP request');
  });

  it('denormalizes success result to { result: data }', () => {
    const res = adapter.denormalize(mockResult(true)) as Record<string, unknown>;
    expect(res['result']).toEqual({ value: 42 });
  });

  it('denormalizes error result to { error: {...} }', () => {
    const res = adapter.denormalize(mockResult(false)) as Record<string, unknown>;
    expect(res['error']).toBeDefined();
    expect((res['error'] as Record<string, unknown>)['message']).toBe('fail');
  });
});
