import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCapabilities, runCapabilitiesSearch } from './search';

test('searchCapabilities filters and sorts by useCount', async () => {
  const fakeFetch: typeof fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        servers: [
          {
            qualifiedName: '@modelcontextprotocol/server-filesystem',
            displayName: 'filesystem',
            description: 'file io',
            useCount: 20,
          },
          {
            qualifiedName: '@modelcontextprotocol/server-other',
            displayName: 'other',
            description: 'other thing',
            useCount: 99,
          },
          {
            qualifiedName: '@modelcontextprotocol/server-file-tools',
            displayName: 'file-tools',
            description: 'filesystem helpers',
            useCount: 30,
          },
        ],
      }),
    }) as Response) as typeof fetch;

  const results = await searchCapabilities('file', fakeFetch);

  assert.equal(results.length, 2);
  assert.equal(results[0]?.name, 'file-tools');
  assert.equal(results[1]?.name, 'filesystem');
});

test('searchCapabilities falls back when registry fetch fails', async () => {
  const fakeFetch: typeof fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const results = await searchCapabilities('filesystem', fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.name, 'filesystem');
});

test('runCapabilitiesSearch prints JSON when requested', async () => {
  let output = '';
  await runCapabilitiesSearch('filesystem', { json: true }, { write: (text) => (output = text) });
  const parsed = JSON.parse(output) as Array<{ name: string }>;
  assert.ok(Array.isArray(parsed));
});
