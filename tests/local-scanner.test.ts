/**
 * tests/local-scanner.test.ts
 * Unit tests for src/discovery/local-scanner.ts.
 * Uses a real temporary directory tree (no mocks of `fs`) so manifest parsing,
 * recursion rules and metadata mapping are exercised end to end.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalScanner } from '../src/discovery/local-scanner';

let root: string;
const scanners: LocalScanner[] = [];

/** Write `contents` (object → JSON, string → verbatim) to root/relPath, creating parents. */
function write(relPath: string, contents: unknown): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return full;
}

function makeScanner(paths: string[] = [root]): LocalScanner {
  const scanner = new LocalScanner(paths);
  scanners.push(scanner);
  return scanner;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-scanner-test-'));
});

afterEach(() => {
  for (const scanner of scanners.splice(0)) scanner.stopWatching();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('LocalScanner manifest discovery', () => {
  it('reports itself as the "local" registry and as always available', async () => {
    const scanner = makeScanner();
    expect(scanner.name).toBe('local');
    await expect(scanner.isAvailable()).resolves.toBe(true);
  });

  it('returns nothing when the scan path does not exist', async () => {
    const scanner = makeScanner([path.join(root, 'does-not-exist')]);
    await expect(scanner.list()).resolves.toEqual([]);
  });

  it('discovers an mcp.json manifest regardless of its contents', async () => {
    write('alpha/mcp.json', { name: 'alpha', version: '1.2.3', description: 'Alpha tool' });

    const [tool] = await makeScanner().list();

    expect(tool).toMatchObject({
      id: 'local:alpha',
      name: 'alpha',
      version: '1.2.3',
      description: 'Alpha tool',
      source: 'local',
      verified: false,
      riskLevel: 'low',
    });
  });

  it('discovers a package.json only when it declares MCP support', async () => {
    write('mcp-true/package.json', { name: 'mcp-true', mcp: true });
    write('server-true/package.json', { name: 'server-true', 'mcp-server': true });
    write('mcp-object/package.json', { name: 'mcp-object', mcp: { capabilities: ['x'] } });
    write('server-object/package.json', { name: 'server-object', 'mcp-server': { a: 1 } });
    write('plain/package.json', { name: 'plain-npm-package' });

    const ids = (await makeScanner().list()).map((t) => t.id).sort();

    expect(ids).toEqual([
      'local:mcp-object',
      'local:mcp-true',
      'local:server-object',
      'local:server-true',
    ]);
  });

  it('falls back to the directory name, a default version and a default description', async () => {
    write('my-dir/mcp.json', {});

    const [tool] = await makeScanner().list();

    expect(tool).toMatchObject({
      id: 'local:my-dir',
      name: 'my-dir',
      version: '0.0.0',
      description: 'Local MCP server: my-dir',
    });
  });

  it('recurses into nested directories', async () => {
    write('a/b/c/mcp.json', { name: 'deep' });

    const ids = (await makeScanner().list()).map((t) => t.id);

    expect(ids).toEqual(['local:deep']);
  });

  it('skips dot-directories and node_modules', async () => {
    write('.hidden/mcp.json', { name: 'hidden' });
    write('node_modules/pkg/mcp.json', { name: 'vendored' });
    write('visible/mcp.json', { name: 'visible' });

    const ids = (await makeScanner().list()).map((t) => t.id);

    expect(ids).toEqual(['local:visible']);
  });

  it('ignores manifests that are not valid JSON', async () => {
    write('broken/mcp.json', '{ not json');
    write('ok/mcp.json', { name: 'ok' });

    const ids = (await makeScanner().list()).map((t) => t.id);

    expect(ids).toEqual(['local:ok']);
  });

  it('scans every configured path and de-duplicates by id', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'local-scanner-test-2-'));
    try {
      write('one/mcp.json', { name: 'shared', version: '1.0.0' });
      fs.mkdirSync(path.join(second, 'two'), { recursive: true });
      fs.writeFileSync(
        path.join(second, 'two', 'mcp.json'),
        JSON.stringify({ name: 'shared', version: '2.0.0' }),
      );
      fs.mkdirSync(path.join(second, 'three'), { recursive: true });
      fs.writeFileSync(path.join(second, 'three', 'mcp.json'), JSON.stringify({ name: 'unique' }));

      const tools = await makeScanner([root, second]).list();

      expect(tools.map((t) => t.id).sort()).toEqual(['local:shared', 'local:unique']);
      // Later scan paths win on id collision.
      expect(tools.find((t) => t.id === 'local:shared')?.version).toBe('2.0.0');
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('LocalScanner metadata mapping', () => {
  it('resolves the entry point from entryPoint, then main, then bin', async () => {
    write('ep/mcp.json', { name: 'ep', entryPoint: 'run.js', main: 'ignored.js' });
    write('main/mcp.json', { name: 'main', main: 'index.js', bin: 'ignored.js' });
    write('bin-string/mcp.json', { name: 'bin-string', bin: 'cli.js' });
    write('bin-object/mcp.json', { name: 'bin-object', bin: { first: 'one.js', second: 'two.js' } });
    write('none/mcp.json', { name: 'none' });

    const byName = Object.fromEntries((await makeScanner().list()).map((t) => [t.name, t]));

    expect(byName['ep']?.entryPoint).toBe(path.resolve(root, 'ep', 'run.js'));
    expect(byName['main']?.entryPoint).toBe(path.resolve(root, 'main', 'index.js'));
    expect(byName['bin-string']?.entryPoint).toBe(path.resolve(root, 'bin-string', 'cli.js'));
    expect(byName['bin-object']?.entryPoint).toBe(path.resolve(root, 'bin-object', 'one.js'));
    expect(byName['none']).not.toHaveProperty('entryPoint');
  });

  it('omits entryPoint when bin is an empty object', async () => {
    write('empty-bin/mcp.json', { name: 'empty-bin', bin: {} });

    const [tool] = await makeScanner().list();

    expect(tool).not.toHaveProperty('entryPoint');
  });

  it('resolves author from a string or an object, and omits it when absent', async () => {
    write('s/mcp.json', { name: 's', author: 'Ada' });
    write('o/mcp.json', { name: 'o', author: { name: 'Grace' } });
    write('n/mcp.json', { name: 'n' });

    const byName = Object.fromEntries((await makeScanner().list()).map((t) => [t.name, t]));

    expect(byName['s']?.author).toBe('Ada');
    expect(byName['o']?.author).toBe('Grace');
    expect(byName['n']).not.toHaveProperty('author');
  });

  it('carries the license only when declared', async () => {
    write('lic/mcp.json', { name: 'lic', license: 'MIT' });
    write('nolic/mcp.json', { name: 'nolic' });

    const byName = Object.fromEntries((await makeScanner().list()).map((t) => [t.name, t]));

    expect(byName['lic']?.license).toBe('MIT');
    expect(byName['nolic']).not.toHaveProperty('license');
  });

  it('prefers capabilities from the mcp block over top-level capabilities', async () => {
    write('c1/mcp.json', { name: 'c1', mcp: { capabilities: ['inner'] }, capabilities: ['outer'] });
    write('c2/mcp.json', { name: 'c2', capabilities: ['outer'] });
    write('c3/mcp.json', { name: 'c3' });
    write('c4/mcp.json', { name: 'c4', 'mcp-server': { capabilities: ['via-server'] } });

    const byName = Object.fromEntries((await makeScanner().list()).map((t) => [t.name, t]));

    expect(byName['c1']?.capabilities).toEqual(['inner']);
    expect(byName['c2']?.capabilities).toEqual(['outer']);
    expect(byName['c3']?.capabilities).toEqual([]);
    expect(byName['c4']?.capabilities).toEqual(['via-server']);
  });

  it('builds tags from keywords or tags, and always adds "local" once', async () => {
    write('k/mcp.json', { name: 'k', keywords: ['db', 'sql'] });
    write('t/mcp.json', { name: 't', tags: ['http'] });
    write('both/mcp.json', { name: 'both', keywords: ['local', 'x'] });
    write('neither/mcp.json', { name: 'neither' });

    const byName = Object.fromEntries((await makeScanner().list()).map((t) => [t.name, t]));

    expect(byName['k']?.tags).toEqual(['db', 'sql', 'local']);
    expect(byName['t']?.tags).toEqual(['http', 'local']);
    expect(byName['both']?.tags).toEqual(['local', 'x']);
    expect(byName['neither']?.tags).toEqual(['local']);
  });

  it('lists dependency names and records manifest locations in metadata', async () => {
    const manifestPath = write('deps/mcp.json', {
      name: 'deps',
      dependencies: { zod: '^3.0.0', axios: '^1.0.0' },
      mcp: { transport: 'stdio' },
    });

    const [tool] = await makeScanner().list();

    expect(tool?.dependencies).toEqual(['zod', 'axios']);
    expect(tool?.metadata).toMatchObject({
      manifestPath,
      manifestDir: path.dirname(manifestPath),
      transport: 'stdio',
    });
  });

  it('uses an empty dependency list when none are declared', async () => {
    write('nodeps/mcp.json', { name: 'nodeps' });

    const [tool] = await makeScanner().list();

    expect(tool?.dependencies).toEqual([]);
  });
});

describe('LocalScanner.search()', () => {
  beforeEach(() => {
    write('db/mcp.json', {
      name: 'postgres-tool',
      description: 'Query Postgres databases',
      keywords: ['database', 'sql'],
      capabilities: ['query'],
    });
    write('web/mcp.json', {
      name: 'fetcher',
      description: 'Fetch web pages',
      keywords: ['http'],
      capabilities: ['fetch'],
    });
    write('fs/mcp.json', {
      name: 'files',
      description: 'Read files',
      keywords: ['filesystem'],
      capabilities: ['read'],
    });
  });

  it('returns everything for an empty query', async () => {
    const results = await makeScanner().search({ query: '' });
    expect(results).toHaveLength(3);
  });

  it('treats a whitespace-only query as empty', async () => {
    const results = await makeScanner().search({ query: '   ' });
    expect(results).toHaveLength(3);
  });

  it('matches on name, case-insensitively', async () => {
    const results = await makeScanner().search({ query: 'POSTGRES' });
    expect(results.map((t) => t.name)).toEqual(['postgres-tool']);
  });

  it('matches on description', async () => {
    const results = await makeScanner().search({ query: 'web pages' });
    expect(results.map((t) => t.name)).toEqual(['fetcher']);
  });

  it('matches on tags', async () => {
    const results = await makeScanner().search({ query: 'sql' });
    expect(results.map((t) => t.name)).toEqual(['postgres-tool']);
  });

  it('matches on capabilities', async () => {
    const results = await makeScanner().search({ query: 'fetch' });
    expect(results.map((t) => t.name)).toContain('fetcher');
  });

  it('filters by tag or capability when tags are supplied', async () => {
    const byTag = await makeScanner().search({ query: '', tags: ['http'] });
    const byCapability = await makeScanner().search({ query: '', tags: ['read'] });

    expect(byTag.map((t) => t.name)).toEqual(['fetcher']);
    expect(byCapability.map((t) => t.name)).toEqual(['files']);
  });

  it('ignores an empty tags array', async () => {
    const results = await makeScanner().search({ query: '', tags: [] });
    expect(results).toHaveLength(3);
  });

  it('applies the limit', async () => {
    const results = await makeScanner().search({ query: '', limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('returns nothing for a different source filter', async () => {
    await expect(makeScanner().search({ query: '', source: 'github' })).resolves.toEqual([]);
  });

  it('still searches when the source filter is "local"', async () => {
    const results = await makeScanner().search({ query: '', source: 'local' });
    expect(results).toHaveLength(3);
  });
});

describe('LocalScanner.getById() / forceRescan()', () => {
  it('returns a tool by id, or null when unknown', async () => {
    write('x/mcp.json', { name: 'x' });
    const scanner = makeScanner();

    await expect(scanner.getById('local:x')).resolves.toMatchObject({ name: 'x' });
    await expect(scanner.getById('local:missing')).resolves.toBeNull();
  });

  it('picks up new manifests after forceRescan()', async () => {
    write('first/mcp.json', { name: 'first' });
    const scanner = makeScanner();
    expect(await scanner.list()).toHaveLength(1);

    write('second/mcp.json', { name: 'second' });
    scanner.forceRescan();

    expect((await scanner.list()).map((t) => t.name).sort()).toEqual(['first', 'second']);
  });

  it('drops tools whose manifests were removed after forceRescan()', async () => {
    const manifest = write('gone/mcp.json', { name: 'gone' });
    const scanner = makeScanner();
    expect(await scanner.list()).toHaveLength(1);

    fs.rmSync(manifest);
    scanner.forceRescan();

    expect(await scanner.list()).toEqual([]);
  });

  it('can stopWatching() repeatedly without error', () => {
    const scanner = makeScanner();
    expect(() => {
      scanner.stopWatching();
      scanner.stopWatching();
    }).not.toThrow();
  });
});
