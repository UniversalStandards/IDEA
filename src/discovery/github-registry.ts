import axios, { type AxiosInstance } from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { type Registry, type RegistrySearchOptions, type ToolMetadata } from './types';

const logger = createLogger('github-registry');

interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  stargazers_count: number;
  updated_at: string;
  topics: string[];
  owner: {
    login: string;
  };
  license: {
    spdx_id: string;
  } | null;
  default_branch: string;
  language: string | null;
}

interface GithubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GithubRepo[];
}

const GITHUB_API = 'https://api.github.com';
const SEARCH_CACHE_KEY_PREFIX = 'gh:search:';
const LIST_CACHE_KEY = 'gh:list';
const AVAILABILITY_CACHE_KEY = 'gh:available';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoToToolMetadata(repo: GithubRepo): ToolMetadata {
  const nameParts = repo.full_name.split('/');
  const owner = nameParts[0] ?? 'unknown';
  const repoName = nameParts[1] ?? repo.name;

  const capabilities: string[] = [];
  const tags = [...(repo.topics ?? [])];

  for (const topic of tags) {
    if (topic.startsWith('mcp-') && topic !== 'mcp-server') {
      capabilities.push(topic.replace(/^mcp-/, ''));
    }
  }

  if (repo.language) {
    tags.push(repo.language.toLowerCase());
  }

  return {
    id: `github:${repo.full_name}`,
    name: repoName,
    version: '0.0.0',
    description: repo.description ?? `MCP server: ${repo.full_name}`,
    source: 'github',
    registryUrl: repo.html_url,
    repository: repo.clone_url,
    installCommand: undefined,
    entryPoint: undefined,
    capabilities,
    tags,
    author: owner,
    license: repo.license?.spdx_id,
    downloadCount: repo.stargazers_count,
    lastUpdated: new Date(repo.updated_at),
    verified: false,
    riskLevel: 'medium',
    metadata: {
      fullName: repo.full_name,
      stars: repo.stargazers_count,
      language: repo.language,
      defaultBranch: repo.default_branch,
    },
  };
}

export class GithubRegistry implements Registry {
  readonly name = 'github';

  private readonly cache: NodeCache;
  private readonly http: AxiosInstance;

  constructor() {
    const ttl = (() => {
      try {
        return config.CACHE_TTL;
      } catch {
        return 300;
      }
    })();

    this.cache = new NodeCache({ stdTTL: ttl, checkperiod: Math.ceil(ttl / 2) });

    const token = (() => {
      try {
        return config.GITHUB_TOKEN;
      } catch {
        return process.env['GITHUB_TOKEN'];
      }
    })();

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    this.http = axios.create({
      baseURL: GITHUB_API,
      headers,
      timeout: 15_000,
    });
  }

  private async requestWithRetry<T>(
    path: string,
    params: Record<string, string | number>,
    attempt = 0,
  ): Promise<T> {
    try {
      const response = await this.http.get<T>(path, { params });
      metrics.increment('github_registry_requests_total', { status: 'success' });
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;

        if (status === 403 || status === 429) {
          const rawHeader = err.response?.headers['retry-after'];
          const retryAfter = parseInt(
            rawHeader !== undefined && rawHeader !== null ? String(rawHeader) : '60',
            10,
          );
          const backoffMs = Math.min(retryAfter * 1000, 120_000);

          if (attempt < 3) {
            logger.warn('GitHub rate limited, backing off', {
              retryAfterMs: backoffMs,
              attempt,
            });
            metrics.increment('github_registry_rate_limits_total');
            await sleep(backoffMs);
            return this.requestWithRetry<T>(path, params, attempt + 1);
          }
        }

        if (status >= 500 && attempt < 2) {
          const backoffMs = 2 ** attempt * 1000;
          logger.warn('GitHub API server error, retrying', { status, attempt });
          await sleep(backoffMs);
          return this.requestWithRetry<T>(path, params, attempt + 1);
        }
      }

      metrics.increment('github_registry_requests_total', { status: 'error' });
      throw err;
    }
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (options.source && options.source !== 'github') return [];

    const limit = options.limit ?? 30;
    const queryParts = ['topic:mcp-server'];

    if (options.query.trim()) {
      queryParts.push(options.query.trim());
    }

    if (options.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        queryParts.push(`topic:${tag}`);
      }
    }

    const q = queryParts.join(' ');
    const cacheKey = `${SEARCH_CACHE_KEY_PREFIX}${q}:${limit}`;

    const cached = this.cache.get<ToolMetadata[]>(cacheKey);
    if (cached) {
      logger.debug('GitHub registry cache hit', { cacheKey });
      return cached;
    }

    try {
      const start = Date.now();
      const data = await this.requestWithRetry<GithubSearchResponse>('/search/repositories', {
        q,
        sort: 'stars',
        order: 'desc',
        per_page: Math.min(limit, 100),
      });

      metrics.histogram('github_registry_search_duration_ms', Date.now() - start);

      const results = data.items.map(repoToToolMetadata);
      this.cache.set(cacheKey, results);

      logger.info('GitHub registry search complete', {
        query: options.query,
        found: results.length,
      });

      return results;
    } catch (err) {
      logger.error('GitHub registry search failed', { query: options.query, err });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('github:')) return null;

    const fullName = id.slice('github:'.length);
    const cacheKey = `gh:repo:${fullName}`;

    const cached = this.cache.get<ToolMetadata>(cacheKey);
    if (cached) return cached;

    try {
      const repo = await this.requestWithRetry<GithubRepo>(`/repos/${fullName}`, {});
      const tool = repoToToolMetadata(repo);
      this.cache.set(cacheKey, tool);
      return tool;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      logger.error('GitHub registry getById failed', { id, err });
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    const cached = this.cache.get<ToolMetadata[]>(LIST_CACHE_KEY);
    if (cached) return cached;

    return this.search({ query: '', limit: 100 });
  }

  async isAvailable(): Promise<boolean> {
    const cached = this.cache.get<boolean>(AVAILABILITY_CACHE_KEY);
    if (cached !== undefined) return cached;

    try {
      await this.http.get('/rate_limit', { timeout: 5_000 });
      this.cache.set(AVAILABILITY_CACHE_KEY, true, 60);
      return true;
    } catch {
      this.cache.set(AVAILABILITY_CACHE_KEY, false, 30);
      logger.warn('GitHub API not reachable');
      return false;
    }
  }
}
