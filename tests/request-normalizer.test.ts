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
  });
});
