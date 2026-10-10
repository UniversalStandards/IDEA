/**
 * tests/github-registry.test.ts
 * Unit tests for src/discovery/github-registry.ts.
 * No real network: axios is replaced by a recorder and back-off sleeps run on
 * fake timers.
 */

const mockGet = jest.fn();
const mockCreate = jest.fn();

jest.mock('axios', () => {
  const isAxiosError = (e: unknown): boolean =>
    typeof e === 'object' && e !== null && (e as { isAxiosError?: boolean }).isAxiosError === true;
  return {
    __esModule: true,
    default: {
      create: (...args: unknown[]) => {
        mockCreate(...args);
        return { get: mockGet };
      },
      isAxiosError,
    },
    isAxiosError,
  };
});

/** Controls what the lazily-evaluated config proxy returns (or throws). */
const mockConfigState: { ttl: number | 'throw'; token: string | undefined | 'throw' } = {
  ttl: 300,
  token: undefined,
};

jest.mock('../src/config', () => ({
  config: {
    get CACHE_TTL(): number {
      if (mockConfigState.ttl === 'throw') throw new Error('config unavailable');
      return mockConfigState.ttl;
    },
    get GITHUB_TOKEN(): string | undefined {
      if (mockConfigState.token === 'throw') throw new Error('config unavailable');
      return mockConfigState.token;
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
import { GithubRegistry } from '../src/discovery/github-registry';
import { metrics } from '../src/observability/metrics';

interface RepoOverrides {
  full_name?: string;
  name?: string;
  description?: string | null;
  topics?: string[] | undefined;
  language?: string | null;
  license?: { spdx_id: string } | null;
  stargazers_count?: number;
}

function repo(overrides: RepoOverrides = {}): Record<string, unknown> {
  return {
    id: 1,
    full_name: 'acme/mcp-widgets',
    name: 'mcp-widgets',
    description: 'Widget tools',
    html_url: 'https://github.com/acme/mcp-widgets',
    clone_url: 'https://github.com/acme/mcp-widgets.git',
    stargazers_count: 42,
    updated_at: '2026-01-02T03:04:05Z',
    topics: ['mcp-server'],
    owner: { login: 'acme' },
    license: { spdx_id: 'MIT' },
    default_branch: 'main',
    language: 'TypeScript',
    ...overrides,
  };
}

function axiosError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), {
    isAxiosError: true,
    response: { status, headers },
  });
}

const registries: GithubRegistry[] = [];

function makeRegistry(): GithubRegistry {
  const registry = new GithubRegistry();
  registries.push(registry);
  return registry;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigState.ttl = 300;
  mockConfigState.token = undefined;
  delete process.env['GITHUB_TOKEN'];
});

afterEach(() => {
  jest.useRealTimers();
  for (const registry of registries.splice(0)) {
    (registry as unknown as { cache: NodeCache }).cache.close();
  }
});

describe('GithubRegistry construction', () => {
  it('sends the GitHub API version headers and no Authorization when there is no token', () => {
    makeRegistry();

    const options = mockCreate.mock.calls[0]?.[0] as { baseURL: string; headers: Record<string, string> };
    expect(options.baseURL).toBe('https://api.github.com');
    expect(options.headers['Accept']).toBe('application/vnd.github.v3+json');
    expect(options.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('adds a Bearer Authorization header when a token is configured', () => {
    mockConfigState.token = 'ghp_configured';
    makeRegistry();

    const options = mockCreate.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(options.headers['Authorization']).toBe('Bearer ghp_configured');
  });

  it('falls back to the GITHUB_TOKEN environment variable when config is unavailable', () => {
    mockConfigState.token = 'throw';
    process.env['GITHUB_TOKEN'] = 'ghp_from_env';
    makeRegistry();

    const options = mockCreate.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(options.headers['Authorization']).toBe('Bearer ghp_from_env');
  });

  it('constructs successfully when the cache TTL cannot be read from config', () => {
    mockConfigState.ttl = 'throw';
    expect(() => makeRegistry()).not.toThrow();
  });

  it('identifies itself as the "github" registry', () => {
    expect(makeRegistry().name).toBe('github');
  });
});

describe('GithubRegistry.search()', () => {
  it('queries the repository search API for MCP servers, sorted by stars', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });

    await makeRegistry().search({ query: 'postgres' });

    expect(mockGet).toHaveBeenCalledWith('/search/repositories', {
      params: {
        q: 'topic:mcp-server postgres',
        sort: 'stars',
        order: 'desc',
        per_page: 30,
      },
    });
  });

  it('omits the free-text term for an empty or blank query', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });

    await makeRegistry().search({ query: '   ' });

    const params = (mockGet.mock.calls[0]?.[1] as { params: { q: string } }).params;
    expect(params.q).toBe('topic:mcp-server');
  });

  it('adds one topic qualifier per tag', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });

    await makeRegistry().search({ query: '', tags: ['database', 'sql'] });

    const params = (mockGet.mock.calls[0]?.[1] as { params: { q: string } }).params;
    expect(params.q).toBe('topic:mcp-server topic:database topic:sql');
  });

  it('caps per_page at 100 regardless of the requested limit', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });

    await makeRegistry().search({ query: '', limit: 500 });

    const params = (mockGet.mock.calls[0]?.[1] as { params: { per_page: number } }).params;
    expect(params.per_page).toBe(100);
  });

  it('maps repositories to tool metadata', async () => {
    mockGet.mockResolvedValue({
      data: {
        items: [
          repo({
            topics: ['mcp-server', 'mcp-database', 'mcp-search', 'tools'],
            language: 'TypeScript',
          }),
        ],
      },
    });

    const [tool] = await makeRegistry().search({ query: 'widgets' });

    expect(tool).toMatchObject({
      id: 'github:acme/mcp-widgets',
      name: 'mcp-widgets',
      version: '0.0.0',
      description: 'Widget tools',
      source: 'github',
      registryUrl: 'https://github.com/acme/mcp-widgets',
      repository: 'https://github.com/acme/mcp-widgets.git',
      author: 'acme',
      license: 'MIT',
      downloadCount: 42,
      verified: false,
      riskLevel: 'medium',
      // "mcp-server" itself is not a capability; other "mcp-" topics are.
      capabilities: ['database', 'search'],
      tags: ['mcp-server', 'mcp-database', 'mcp-search', 'tools', 'typescript'],
      metadata: {
        fullName: 'acme/mcp-widgets',
        stars: 42,
        language: 'TypeScript',
        defaultBranch: 'main',
      },
    });
    expect(tool?.lastUpdated).toEqual(new Date('2026-01-02T03:04:05Z'));
    expect(tool).not.toHaveProperty('installCommand');
    expect(tool).not.toHaveProperty('entryPoint');
  });

  it('handles repositories without a description, license, language or topics', async () => {
    mockGet.mockResolvedValue({
      data: {
        items: [repo({ description: null, license: null, language: null, topics: undefined })],
      },
    });

    const [tool] = await makeRegistry().search({ query: '' });

    expect(tool?.description).toBe('MCP server: acme/mcp-widgets');
    expect(tool).not.toHaveProperty('license');
    expect(tool?.tags).toEqual([]);
    expect(tool?.capabilities).toEqual([]);
  });

  it('uses the repository name when full_name has no owner/repo separator', async () => {
    mockGet.mockResolvedValue({
      data: { items: [repo({ full_name: 'noslash', name: 'fallback-name' })] },
    });

    const [tool] = await makeRegistry().search({ query: '' });

    expect(tool?.name).toBe('fallback-name');
    expect(tool?.author).toBe('noslash');
  });

  it('serves a repeated identical search from cache', async () => {
    mockGet.mockResolvedValue({ data: { items: [repo()] } });
    const registry = makeRegistry();

    const first = await registry.search({ query: 'cached' });
    const second = await registry.search({ query: 'cached' });

    expect(second).toEqual(first);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not share cache entries across different limits', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });
    const registry = makeRegistry();

    await registry.search({ query: 'x', limit: 10 });
    await registry.search({ query: 'x', limit: 20 });

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('returns nothing for a different source filter without calling GitHub', async () => {
    await expect(makeRegistry().search({ query: 'x', source: 'official' })).resolves.toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('searches when the source filter is "github"', async () => {
    mockGet.mockResolvedValue({ data: { items: [repo()] } });

    const results = await makeRegistry().search({ query: '', source: 'github' });

    expect(results).toHaveLength(1);
  });

  it('returns an empty list (not an exception) when the API call fails', async () => {
    mockGet.mockRejectedValue(new Error('network down'));

    await expect(makeRegistry().search({ query: 'x' })).resolves.toEqual([]);
    expect(metrics.increment).toHaveBeenCalledWith('github_registry_requests_total', { status: 'error' });
  });

  it('records success metrics for a good call', async () => {
    mockGet.mockResolvedValue({ data: { items: [] } });

    await makeRegistry().search({ query: 'x' });

    expect(metrics.increment).toHaveBeenCalledWith('github_registry_requests_total', { status: 'success' });
    expect(metrics.histogram).toHaveBeenCalledWith('github_registry_search_duration_ms', expect.any(Number));
  });
});

describe('GithubRegistry rate limiting and retries', () => {
  it('waits for Retry-After on HTTP 429 and then succeeds', async () => {
    jest.useFakeTimers();
    mockGet
      .mockRejectedValueOnce(axiosError(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce({ data: { items: [repo()] } });

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const results = await pending;

    expect(results).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith('github_registry_rate_limits_total');
  });

  it('defaults to a 60s back-off on HTTP 403 without a Retry-After header', async () => {
    jest.useFakeTimers();
    mockGet
      .mockRejectedValueOnce(axiosError(403))
      .mockResolvedValueOnce({ data: { items: [] } });

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(59_999);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await pending;

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('caps the rate-limit back-off at 120s', async () => {
    jest.useFakeTimers();
    mockGet
      .mockRejectedValueOnce(axiosError(429, { 'retry-after': '99999' }))
      .mockResolvedValueOnce({ data: { items: [] } });

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(119_999);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await pending;

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated rate limiting and returns an empty list', async () => {
    jest.useFakeTimers();
    mockGet.mockRejectedValue(axiosError(429, { 'retry-after': '1' }));

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual([]);
    // Initial attempt + 3 retries.
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  it('retries server errors with exponential back-off (1s, then 2s)', async () => {
    jest.useFakeTimers();
    mockGet
      .mockRejectedValueOnce(axiosError(503))
      .mockRejectedValueOnce(axiosError(502))
      .mockResolvedValueOnce({ data: { items: [repo()] } });

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(999);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockGet).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2_000);
    const results = await pending;

    expect(results).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('stops retrying server errors after two retries', async () => {
    jest.useFakeTimers();
    mockGet.mockRejectedValue(axiosError(500));

    const pending = makeRegistry().search({ query: 'x' });
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors', async () => {
    mockGet.mockRejectedValue(axiosError(422));

    await expect(makeRegistry().search({ query: 'x' })).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-HTTP failures', async () => {
    mockGet.mockRejectedValue(new Error('socket hang up'));

    await expect(makeRegistry().search({ query: 'x' })).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('GithubRegistry.getById()', () => {
  it('rejects ids that are not github-prefixed without calling GitHub', async () => {
    await expect(makeRegistry().getById('official:filesystem')).resolves.toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches a repository by full name and maps it', async () => {
    mockGet.mockResolvedValue({ data: repo() });

    const tool = await makeRegistry().getById('github:acme/mcp-widgets');

    expect(mockGet).toHaveBeenCalledWith('/repos/acme/mcp-widgets', { params: {} });
    expect(tool?.id).toBe('github:acme/mcp-widgets');
  });

  it('caches a fetched repository', async () => {
    mockGet.mockResolvedValue({ data: repo() });
    const registry = makeRegistry();

    await registry.getById('github:acme/mcp-widgets');
    await registry.getById('github:acme/mcp-widgets');

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('returns null for a repository that does not exist', async () => {
    mockGet.mockRejectedValue(axiosError(404));

    await expect(makeRegistry().getById('github:acme/missing')).resolves.toBeNull();
  });

  it('returns null (not an exception) on other failures', async () => {
    mockGet.mockRejectedValue(new Error('boom'));

    await expect(makeRegistry().getById('github:acme/broken')).resolves.toBeNull();
  });
});

describe('GithubRegistry.list()', () => {
  it('delegates to a 100-result search', async () => {
    mockGet.mockResolvedValue({ data: { items: [repo()] } });

    const tools = await makeRegistry().list();

    expect(tools).toHaveLength(1);
    const params = (mockGet.mock.calls[0]?.[1] as { params: { per_page: number; q: string } }).params;
    expect(params.per_page).toBe(100);
    expect(params.q).toBe('topic:mcp-server');
  });

  it('returns a previously cached list without calling GitHub', async () => {
    const registry = makeRegistry();
    const cached = [{ id: 'github:cached/tool' }];
    (registry as unknown as { cache: NodeCache }).cache.set('gh:list', cached);

    await expect(registry.list()).resolves.toEqual(cached);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('GithubRegistry.isAvailable()', () => {
  it('is true when the rate-limit endpoint responds, and caches the answer', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const registry = makeRegistry();

    await expect(registry.isAvailable()).resolves.toBe(true);
    await expect(registry.isAvailable()).resolves.toBe(true);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/rate_limit', { timeout: 5_000 });
  });

  it('is false when GitHub is unreachable, and caches the negative answer', async () => {
    mockGet.mockRejectedValue(new Error('ENOTFOUND'));
    const registry = makeRegistry();

    await expect(registry.isAvailable()).resolves.toBe(false);
    await expect(registry.isAvailable()).resolves.toBe(false);

    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
