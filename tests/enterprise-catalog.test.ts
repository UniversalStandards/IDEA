/**
 * tests/enterprise-catalog.test.ts
 * Unit tests for src/discovery/enterprise-catalog.ts and
 * src/discovery/enterprise-catalog-adapter.ts.
 * Real temp files are used for the file-based catalog; HTTP is mocked.
 */

const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
}));

interface MockConfig {
  CACHE_TTL: number;
  ENABLE_ENTERPRISE_CATALOG: boolean;
  ENTERPRISE_CATALOG_PATH?: string;
  ENTERPRISE_CATALOG_URL?: string;
}

const mockConfig: { current: MockConfig } = {
  current: { CACHE_TTL: 300, ENABLE_ENTERPRISE_CATALOG: true },
};

jest.mock('../src/config', () => ({
  getConfig: () => mockConfig.current,
}));

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
import type NodeCache from 'node-cache';
import { EnterpriseCatalogConnector, enterpriseCatalog } from '../src/discovery/enterprise-catalog';
import { EnterpriseRegistryAdapter } from '../src/discovery/enterprise-catalog-adapter';
import { RegistrySource } from '../src/types/index';

let dir: string;
const connectors: EnterpriseCatalogConnector[] = [];

function makeConnector(): EnterpriseCatalogConnector {
  const connector = new EnterpriseCatalogConnector();
  connectors.push(connector);
  return connector;
}

function writeCatalog(contents: unknown, name = 'catalog.json'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

const CATALOG = {
  version: '2',
  name: 'Acme Internal',
  tools: [
    {
      name: 'ledger',
      version: '3.1.0',
      description: 'General ledger access',
      tags: ['finance', 'internal'],
      packageName: '@acme/ledger-mcp',
      repositoryUrl: 'https://git.acme.example/ledger',
      trustScore: 0.9,
      metadata: { owner: 'finance-platform' },
    },
    {
      name: 'wiki',
      description: 'Company wiki search',
      tags: ['docs'],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-catalog-test-'));
  mockConfig.current = { CACHE_TTL: 300, ENABLE_ENTERPRISE_CATALOG: true };
});

afterEach(() => {
  for (const connector of connectors.splice(0)) {
    (connector as unknown as { cache: NodeCache }).cache.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  (enterpriseCatalog as unknown as { cache: NodeCache }).cache.close();
});

describe('EnterpriseCatalogConnector.discover() — gating', () => {
  it('identifies itself as the enterprise source', () => {
    const connector = makeConnector();
    expect(connector.name).toBe('enterprise-catalog');
    expect(connector.source).toBe(RegistrySource.ENTERPRISE);
  });

  it('reports whether the catalog is enabled from config', () => {
    const connector = makeConnector();
    expect(connector.isEnabled()).toBe(true);
    mockConfig.current = { ...mockConfig.current, ENABLE_ENTERPRISE_CATALOG: false };
    expect(connector.isEnabled()).toBe(false);
  });

  it('returns nothing when the catalog is disabled', async () => {
    mockConfig.current = { CACHE_TTL: 300, ENABLE_ENTERPRISE_CATALOG: false, ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG) };

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('returns nothing when enabled but neither a path nor a URL is configured', async () => {
    await expect(makeConnector().discover()).resolves.toEqual([]);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});

describe('EnterpriseCatalogConnector.discover() — file catalogs', () => {
  it('loads and maps tools from a JSON file', async () => {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG) };

    const tools = await makeConnector().discover();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: 'ledger',
      version: '3.1.0',
      description: 'General ledger access',
      source: RegistrySource.ENTERPRISE,
      packageName: '@acme/ledger-mcp',
      repositoryUrl: 'https://git.acme.example/ledger',
      tags: ['finance', 'internal'],
      trustScore: 0.9,
      metadata: { owner: 'finance-platform' },
    });
  });

  it('applies defaults and omits absent optional fields', async () => {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG) };

    const wiki = (await makeConnector().discover()).find((t) => t.name === 'wiki');

    expect(wiki).toEqual({
      name: 'wiki',
      version: '1.0.0',
      description: 'Company wiki search',
      source: RegistrySource.ENTERPRISE,
      tags: ['docs'],
      metadata: {},
    });
    expect(wiki).not.toHaveProperty('packageName');
    expect(wiki).not.toHaveProperty('repositoryUrl');
    expect(wiki).not.toHaveProperty('trustScore');
  });

  it('treats an empty repositoryUrl as absent', async () => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_PATH: writeCatalog({ tools: [{ name: 't', repositoryUrl: '' }] }),
    };

    const [tool] = await makeConnector().discover();

    expect(tool).not.toHaveProperty('repositoryUrl');
  });

  it('prefers the file path over the URL when both are configured', async () => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG),
      ENTERPRISE_CATALOG_URL: 'https://catalog.acme.example/tools.json',
    };

    await makeConnector().discover();

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('returns nothing when the file does not exist', async () => {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: path.join(dir, 'missing.json') };

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('returns nothing when the file is not valid JSON', async () => {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: writeCatalog('{ nope') };

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('returns nothing when the catalog fails schema validation', async () => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_PATH: writeCatalog({ tools: [{ version: '1.0.0' }] }),
    };

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('rejects a trust score outside 0..1', async () => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_PATH: writeCatalog({ tools: [{ name: 't', trustScore: 1.5 }] }),
    };

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('filters by query across name, description and tags, case-insensitively', async () => {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG) };
    const connector = makeConnector();

    expect((await connector.discover('LEDGER')).map((t) => t.name)).toEqual(['ledger']);
    expect((await connector.discover('wiki search')).map((t) => t.name)).toEqual(['wiki']);
    expect((await connector.discover('internal')).map((t) => t.name)).toEqual(['ledger']);
    expect(await connector.discover('no-such-thing')).toEqual([]);
  });

  it('caches results per query, so the file is read once', async () => {
    const file = writeCatalog(CATALOG);
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: file };
    const connector = makeConnector();

    const first = await connector.discover();
    fs.rmSync(file);
    const second = await connector.discover();

    expect(second).toEqual(first);
  });
});

describe('EnterpriseCatalogConnector.discover() — URL catalogs', () => {
  beforeEach(() => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_URL: 'https://catalog.acme.example/tools.json',
    };
  });

  it('fetches and maps a JSON catalog over HTTP', async () => {
    mockAxiosGet.mockResolvedValue({ data: CATALOG });

    const tools = await makeConnector().discover();

    expect(tools.map((t) => t.name)).toEqual(['ledger', 'wiki']);
    expect(mockAxiosGet).toHaveBeenCalledWith('https://catalog.acme.example/tools.json', {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });
  });

  it('returns nothing when the request fails', async () => {
    mockAxiosGet.mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('copes with a non-Error rejection', async () => {
    mockAxiosGet.mockRejectedValue('boom');

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('returns nothing when the response body is not a valid catalog', async () => {
    mockAxiosGet.mockResolvedValue({ data: { unexpected: true } });

    await expect(makeConnector().discover()).resolves.toEqual([]);
  });

  it('caches the fetched catalog', async () => {
    mockAxiosGet.mockResolvedValue({ data: CATALOG });
    const connector = makeConnector();

    await connector.discover();
    await connector.discover();

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });
});

describe('EnterpriseRegistryAdapter', () => {
  /** The adapter bridges the module-level singleton, so point *its* config at a file. */
  function useCatalog(): void {
    mockConfig.current = { ...mockConfig.current, ENTERPRISE_CATALOG_PATH: writeCatalog(CATALOG) };
    (enterpriseCatalog as unknown as { cache: NodeCache }).cache.flushAll();
  }

  it('identifies itself and mirrors the connector enabled flag as availability', async () => {
    const adapter = new EnterpriseRegistryAdapter();
    expect(adapter.name).toBe('enterprise-catalog');

    await expect(adapter.isAvailable()).resolves.toBe(true);
    mockConfig.current = { ...mockConfig.current, ENABLE_ENTERPRISE_CATALOG: false };
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('lists every tool as registry metadata', async () => {
    useCatalog();

    const tools = await new EnterpriseRegistryAdapter().list();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      id: '@acme/ledger-mcp',
      name: 'ledger',
      version: '3.1.0',
      source: 'enterprise',
      repository: 'https://git.acme.example/ledger',
      tags: ['finance', 'internal'],
      capabilities: [],
      verified: true,
      metadata: { owner: 'finance-platform' },
    });
  });

  it('uses the name as id when there is no package name, and omits unset optional fields', async () => {
    useCatalog();

    const wiki = (await new EnterpriseRegistryAdapter().list()).find((t) => t.name === 'wiki');

    expect(wiki?.id).toBe('wiki');
    expect(wiki).not.toHaveProperty('repository');
    expect(wiki).not.toHaveProperty('verified');
  });

  it('marks a tool unverified when its trust score is below 0.7', async () => {
    mockConfig.current = {
      ...mockConfig.current,
      ENTERPRISE_CATALOG_PATH: writeCatalog({ tools: [{ name: 'shaky', trustScore: 0.69 }] }),
    };
    (enterpriseCatalog as unknown as { cache: NodeCache }).cache.flushAll();

    const [tool] = await new EnterpriseRegistryAdapter().list();

    expect(tool?.verified).toBe(false);
  });

  it('searches by query', async () => {
    useCatalog();

    const results = await new EnterpriseRegistryAdapter().search({ query: 'ledger' });

    expect(results.map((t) => t.name)).toEqual(['ledger']);
  });

  it('gets a tool by package name or by name, and returns null for unknown ids', async () => {
    useCatalog();
    const adapter = new EnterpriseRegistryAdapter();

    expect((await adapter.getById('@acme/ledger-mcp'))?.name).toBe('ledger');
    expect((await adapter.getById('wiki'))?.name).toBe('wiki');
    await expect(adapter.getById('nope')).resolves.toBeNull();
  });
});
