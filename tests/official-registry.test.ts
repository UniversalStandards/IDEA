/**
 * tests/official-registry.test.ts
 * Unit tests for src/discovery/official-registry.ts.
 * The MCP Registry HTTP API is mocked; the curated seed list is real.
 */

const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
}));

const mockConfigState: { ttl: number | 'throw'; url: string | 'throw' } = {
  ttl: 300,
  url: 'https://registry.example.test',
};

jest.mock('../src/config', () => ({
  config: {
    get CACHE_TTL(): number {
      if (mockConfigState.ttl === 'throw') throw new Error('config unavailable');
      return mockConfigState.ttl;
    },
    get OFFICIAL_MCP_REGISTRY_URL(): string {
      if (mockConfigState.url === 'throw') throw new Error('config unavailable');
      return mockConfigState.url;
    },
  },
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn() },
}));

import type NodeCache from 'node-cache';
import {
  OfficialRegistry,
  launchCommandFor,
  registryEntryToToolMetadata,
  DEFAULT_REGISTRY_URL,
} from '../src/discovery/official-registry';
import { metrics } from '../src/observability/metrics';

const SEED_IDS = [
  'official:filesystem',
  'official:github',
  'official:web-search',
  'official:sqlite',
  'official:postgres',
  'official:slack',
  'official:memory',
  'official:puppeteer',
  'official:fetch',
  'official:google-maps',
  'official:time',
  'official:sequential-thinking',
  'official:everything',
];

const META_KEY = 'io.modelcontextprotocol.registry/official';

function entry(
  name: string,
  packages: unknown[],
  meta: Record<string, unknown> = { status: 'active', isLatest: true, updatedAt: '2026-06-01T00:00:00Z' },
  extra: Record<string, unknown> = {},
): unknown {
  return {
    server: { name, description: `${name} server`, version: '1.2.3', packages, ...extra },
    _meta: { [META_KEY]: meta },
  };
}

const npmPkg = {
  registryType: 'npm',
  identifier: '@acme/widgets-mcp',
  version: '1.2.3',
  transport: { type: 'stdio' },
  environmentVariables: [
    { name: 'WIDGETS_API_KEY', isRequired: true, isSecret: true, description: 'API key' },
    { name: 'WIDGETS_REGION' },
  ],
  packageArguments: [{ name: 'root', type: 'positional', isRequired: true, description: 'Root dir' }],
};

const registries: OfficialRegistry[] = [];

function makeRegistry(baseUrl?: string): OfficialRegistry {
  const registry = new OfficialRegistry(baseUrl);
  registries.push(registry);
  return registry;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigState.ttl = 300;
  mockConfigState.url = 'https://registry.example.test';
});

afterEach(() => {
  for (const registry of registries.splice(0)) {
    (registry as unknown as { cache: NodeCache }).cache.close();
  }
});

describe('launchCommandFor()', () => {
  it('launches npm packages with npx at the published version', () => {
    expect(launchCommandFor({ registryType: 'npm', identifier: '@a/b', version: '2.0.0' })).toBe('npx -y @a/b@2.0.0');
  });

  it('launches PyPI packages with uvx at the published version', () => {
    expect(launchCommandFor({ registryType: 'pypi', identifier: 'mcp-thing', version: '0.4.1' })).toBe(
      'uvx mcp-thing==0.4.1',
    );
  });

  it('omits "latest" and empty versions', () => {
    expect(launchCommandFor({ registryType: 'npm', identifier: 'pkg', version: 'latest' })).toBe('npx -y pkg');
    expect(launchCommandFor({ registryType: 'pypi', identifier: 'pkg', version: '' })).toBe('uvx pkg');
  });

  it('rejects non-stdio transports and unsupported registries', () => {
    expect(
      launchCommandFor({ registryType: 'npm', identifier: 'pkg', transport: { type: 'streamable-http' } }),
    ).toBeUndefined();
    expect(launchCommandFor({ registryType: 'oci', identifier: 'ghcr.io/a/b' })).toBeUndefined();
    expect(launchCommandFor({ registryType: 'nuget', identifier: 'A.B' })).toBeUndefined();
  });

  it('rejects identifiers containing shell metacharacters or whitespace', () => {
    expect(launchCommandFor({ registryType: 'npm', identifier: 'pkg; rm -rf /' })).toBeUndefined();
    expect(launchCommandFor({ registryType: 'pypi', identifier: 'a b' })).toBeUndefined();
  });
});

describe('registryEntryToToolMetadata()', () => {
  it('maps an installable npm server with its required env and args', () => {
    const tool = registryEntryToToolMetadata(
      entry('io.github.acme/widgets', [npmPkg], undefined, { repository: { url: 'https://github.com/acme/w' } }) as never,
      'https://reg.test',
    );
    expect(tool).toMatchObject({
      id: 'mcp:io.github.acme/widgets',
      name: 'io.github.acme/widgets',
      version: '1.2.3',
      source: 'official',
      installCommand: 'npx -y @acme/widgets-mcp@1.2.3',
      repository: 'https://github.com/acme/w',
      tags: ['mcp-registry', 'npm'],
      verified: false,
      riskLevel: 'medium',
    });
    expect(tool.registryUrl).toBe('https://reg.test/v0/servers?search=io.github.acme%2Fwidgets');
    expect(tool.metadata).toMatchObject({
      installable: true,
      requiredEnv: [{ name: 'WIDGETS_API_KEY', secret: true, description: 'API key' }],
      requiredArgs: [{ name: 'root', type: 'positional', description: 'Root dir' }],
      status: 'active',
    });
    expect(tool.lastUpdated).toEqual(new Date('2026-06-01T00:00:00Z'));
  });

  it('prefers the npm package when several are published', () => {
    const tool = registryEntryToToolMetadata(
      entry('x/y', [
        { registryType: 'pypi', identifier: 'y-mcp', version: '1.0.0' },
        { registryType: 'npm', identifier: 'y-mcp', version: '1.0.0' },
      ]) as never,
      'https://reg.test',
    );
    expect(tool.installCommand).toBe('npx -y y-mcp@1.0.0');
  });

  it('marks remote-only servers as not installable with a reason', () => {
    const tool = registryEntryToToolMetadata(
      entry('x/remote', [], undefined, { remotes: [{ type: 'streamable-http', url: 'https://x.test/mcp' }] }) as never,
      'https://reg.test',
    );
    expect(tool.installCommand).toBeUndefined();
    expect(tool.metadata).toMatchObject({ installable: false });
    expect(String(tool.metadata?.['unsupportedReason'])).toContain('Remote-only');
  });

  it('names the unsupported package types', () => {
    const tool = registryEntryToToolMetadata(
      entry('x/oci', [{ registryType: 'oci', identifier: 'ghcr.io/x/oci:1' }]) as never,
      'https://reg.test',
    );
    expect(String(tool.metadata?.['unsupportedReason'])).toContain('oci');
  });

  it('falls back to defaults for sparse entries', () => {
    const tool = registryEntryToToolMetadata({ server: { name: 'bare/server' } } as never, 'https://reg.test');
    expect(tool).toMatchObject({ version: '0.0.0', description: '', tags: ['mcp-registry'] });
    expect(tool).not.toHaveProperty('lastUpdated');
  });
});

describe('OfficialRegistry', () => {
  it('identifies itself as "official", is always available, and trims the base URL', async () => {
    const registry = makeRegistry('https://reg.test///');
    expect(registry.name).toBe('official');
    await expect(registry.isAvailable()).resolves.toBe(true);
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    await registry.list();
    expect(mockAxiosGet).toHaveBeenCalledWith('https://reg.test/v0/servers', expect.anything());
  });

  it('uses the configured registry URL, or the default when config is unavailable', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    await makeRegistry().list();
    expect(mockAxiosGet).toHaveBeenLastCalledWith('https://registry.example.test/v0/servers', expect.anything());

    mockConfigState.url = 'throw';
    mockConfigState.ttl = 'throw';
    await makeRegistry().list();
    expect(mockAxiosGet).toHaveBeenLastCalledWith(`${DEFAULT_REGISTRY_URL}/v0/servers`, expect.anything());
  });

  it('searches the registry for the latest version with a bounded page size and timeout', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [entry('a/widgets', [npmPkg])], metadata: { count: 1 } } });

    const results = await makeRegistry().search({ query: 'Widgets', limit: 500 });

    expect(mockAxiosGet).toHaveBeenCalledWith('https://registry.example.test/v0/servers', {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
      params: { search: 'widgets', limit: 100, version: 'latest' },
    });
    expect(results.map((t) => t.id)).toEqual(['mcp:a/widgets']);
    expect(metrics.histogram).toHaveBeenCalledWith('official_registry_fetch_duration_ms', expect.any(Number));
  });

  it('puts matching curated seeds before registry results', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [entry('z/memory-plus', [npmPkg])] } });

    const results = await makeRegistry().search({ query: 'memory' });

    expect(results.map((t) => t.id)).toEqual(['official:memory', 'mcp:z/memory-plus']);
  });

  it('skips superseded, deleted, deprecated, duplicate and malformed entries', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        servers: [
          entry('a/old', [npmPkg], { isLatest: false }),
          entry('a/gone', [npmPkg], { status: 'deleted' }),
          entry('a/dep', [npmPkg], { status: 'deprecated' }),
          entry('a/ok', [npmPkg]),
          entry('a/ok', [npmPkg]),
          { nope: true },
          entry('a/nometa', [npmPkg], undefined),
        ],
      },
    });

    const results = await makeRegistry().search({ query: 'zzz' });

    expect(results.map((t) => t.id)).toEqual(['mcp:a/ok', 'mcp:a/nometa']);
  });

  it('caches search results per query', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();

    await registry.search({ query: 'x', limit: 5 });
    await registry.search({ query: 'x', limit: 5 });
    await registry.search({ query: 'y', limit: 5 });

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it('falls back to the seed list and counts the fallback when the registry is unreachable', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const tools = await makeRegistry().list();

    expect(tools.map((t) => t.id)).toEqual(SEED_IDS);
    expect(metrics.increment).toHaveBeenCalledWith('official_registry_fallback_total');
  });

  it('copes with a non-Error rejection and an invalid response body', async () => {
    mockAxiosGet.mockRejectedValueOnce('plain string failure');
    await expect(makeRegistry().list()).resolves.toHaveLength(SEED_IDS.length);

    mockAxiosGet.mockResolvedValueOnce({ data: { servers: 'not-an-array' } });
    await expect(makeRegistry().list()).resolves.toHaveLength(SEED_IDS.length);
  });

  it('lists seeds plus the first registry page, cached', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [entry('b/one', [npmPkg])] } });
    const registry = makeRegistry();

    const first = await registry.list();
    await registry.list();

    expect(first.map((t) => t.id)).toEqual([...SEED_IDS, 'mcp:b/one']);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      params: { limit: 100, version: 'latest' },
    }));
  });

  it('returns seeds plus the registry list for an empty query', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [entry('b/one', [npmPkg])] } });
    const results = await makeRegistry().search({ query: '  ' });
    expect(results).toHaveLength(SEED_IDS.length + 1);
  });

  it('filters by tag or capability and applies the limit', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();

    const db = await registry.search({ query: '', tags: ['database'] });
    expect(db.map((t) => t.id).sort()).toEqual(['official:postgres', 'official:sqlite']);

    const geo = await registry.search({ query: '', tags: ['geocode'] });
    expect(geo.map((t) => t.id)).toEqual(['official:google-maps']);

    const all = await registry.search({ query: '', tags: [] });
    expect(all).toHaveLength(SEED_IDS.length);

    await expect(registry.search({ query: '', limit: 3 })).resolves.toHaveLength(3);
  });

  it('matches seeds on name, description, tags and capabilities', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();
    expect((await registry.search({ query: 'SQLITE' })).map((t) => t.id)).toContain('official:sqlite');
    expect((await registry.search({ query: 'knowledge-graph' })).map((t) => t.id)).toEqual(['official:memory']);
    expect((await registry.search({ query: 'convert_time' })).map((t) => t.id)).toEqual(['official:time']);
  });

  it('returns nothing for a different source without fetching', async () => {
    await expect(makeRegistry().search({ query: '', source: 'github' })).resolves.toEqual([]);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('maps the Python reference servers to uvx', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();
    expect((await registry.getById('official:fetch'))?.installCommand).toBe('uvx mcp-server-fetch');
    expect((await registry.getById('official:time'))?.installCommand).toBe('uvx mcp-server-time');
    expect((await registry.getById('official:sqlite'))?.installCommand).toBe('uvx mcp-server-sqlite');
  });
});

describe('OfficialRegistry.getById()', () => {
  it('finds a seed tool without a request', async () => {
    const tool = await makeRegistry().getById('official:postgres');
    expect(tool?.name).toBe('postgres');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('returns a registry tool already seen in a search without another request', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [entry('a/widgets', [npmPkg])] } });
    const registry = makeRegistry();
    await registry.search({ query: 'widgets' });

    await expect(registry.getById('mcp:a/widgets')).resolves.toMatchObject({ name: 'a/widgets' });
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('looks up an unseen registry tool by exact name', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { servers: [entry('a/widgets-extra', [npmPkg]), entry('a/widgets', [npmPkg])] },
    });

    const tool = await makeRegistry().getById('mcp:a/widgets');

    expect(tool?.id).toBe('mcp:a/widgets');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: { search: 'a/widgets', limit: 100, version: 'latest' } }),
    );
  });

  it('returns null for unknown ids', async () => {
    mockAxiosGet.mockResolvedValue({ data: { servers: [] } });
    const registry = makeRegistry();
    await expect(registry.getById('official:nope')).resolves.toBeNull();
    await expect(registry.getById('mcp:nobody/none')).resolves.toBeNull();
    await expect(registry.getById('github:x')).resolves.toBeNull();
  });
});
