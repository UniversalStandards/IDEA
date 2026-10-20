import axios, { type AxiosError, type AxiosInstance } from 'axios';
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

/** Longest back-off slept inside a request (discovery runs in tool calls). */
const MAX_INLINE_BACKOFF_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 2;
/** Upper bound for the "skip GitHub until reset" circuit. */
const MAX_CIRCUIT_MS = 15 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GithubRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`GitHub API rate limited; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'GithubRateLimitedError';
  }
}

/**
 * How long GitHub asks us to wait, or undefined when the error is not a rate
 * limit. 429 is always a rate limit; 403 only when GitHub says so (exhausted
 * quota, a Retry-After header, or a "rate limit" message) — any other 403 is
 * an authorization failure and must not be retried.
 */
export function rateLimitWaitMs(err: AxiosError, nowMs: number = Date.now()): number | undefined {
  const res = err.response;
  if (!res) return undefined;
  const header = (name: string): string | undefined => {
    const v = (res.headers as Record<string, unknown>)[name];
    return v === undefined || v === null ? undefined : String(v);
  };
  const retryAfter = header('retry-after');
  const remaining = header('x-ratelimit-remaining');
  const reset = header('x-ratelimit-reset');
  const body = res.data as { message?: unknown } | undefined;
  const mentionsRateLimit = typeof body?.message === 'string' && /rate limit/i.test(body.message);

  const isRateLimit =
    res.status === 429 ||
    (res.status === 403 && (retryAfter !== undefined || remaining === '0' || mentionsRateLimit));
  if (!isRateLimit) return undefined;

  if (retryAfter !== undefined) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  if (reset !== undefined) {
    const epoch = Number.parseInt(reset, 10);
    if (Number.isFinite(epoch)) return Math.max(0, epoch * 1000 - nowMs);
  }
  return 60_000;
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
    capabilities,
    tags,
    author: owner,
    ...(repo.license?.spdx_id !== undefined ? { license: repo.license.spdx_id } : {}),
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
  /** Epoch ms until which GitHub calls are skipped after a long rate limit. */
  private rateLimitedUntil = 0;

  constructor() {
    const ttl = ((): number => {
      try {
        return config.CACHE_TTL;
      } catch {
        return 300;
      }
    })();

    this.cache = new NodeCache({ stdTTL: ttl, checkperiod: Math.ceil(ttl / 2) });

    const token = ((): string | undefined => {
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

  /**
   * GitHub API call with bounded retries. Discovery runs inside interactive
   * MCP tool calls, so it never sleeps longer than MAX_INLINE_BACKOFF_MS:
   * a longer rate-limit wait opens a short circuit (searches return [] until
   * the reset time) instead of stalling the caller for minutes. A 403 that is
   * not a rate limit (bad token, SSO-protected org) fails immediately.
   */
  private async requestWithRetry<T>(
    path: string,
    params: Record<string, string | number>,
    attempt = 0,
  ): Promise<T> {
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      metrics.increment('github_registry_requests_total', { status: 'rate_limited' });
      throw new GithubRateLimitedError(this.rateLimitedUntil - now);
    }

    try {
      const response = await this.http.get<T>(path, { params });
      metrics.increment('github_registry_requests_total', { status: 'success' });
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const waitMs = rateLimitWaitMs(err);

        if (waitMs !== undefined) {
          metrics.increment('github_registry_rate_limits_total');
          if (waitMs <= MAX_INLINE_BACKOFF_MS && attempt < MAX_RATE_LIMIT_RETRIES) {
            logger.warn('GitHub rate limited, backing off briefly', { retryAfterMs: waitMs, attempt });
            await sleep(waitMs);
            return this.requestWithRetry<T>(path, params, attempt + 1);
          }
          this.rateLimitedUntil = Date.now() + Math.min(waitMs, MAX_CIRCUIT_MS);
          logger.warn('GitHub rate limited; skipping GitHub discovery until reset', {
            retryAfterMs: waitMs,
            hint: 'set GITHUB_TOKEN to raise the limit',
          });
          metrics.increment('github_registry_requests_total', { status: 'rate_limited' });
          throw new GithubRateLimitedError(waitMs);
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
      if (err instanceof GithubRateLimitedError) {
        logger.debug('GitHub registry skipped (rate limited)', { retryAfterMs: err.retryAfterMs });
        return [];
      }
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
