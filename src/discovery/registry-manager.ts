import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { getRedis } from '../core/redis-client';
import { GithubRegistry } from './github-registry';
import { OfficialRegistry } from './official-registry';
import { LocalScanner } from './local-scanner';
import { Registry, RegistrySearchOptions, ToolMetadata } from './types';

const logger = createLogger('registry-manager');

// ── Redis cache helpers ──────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = 'registry:';

function getCacheTtl(): number {
  try {
    return config.CACHE_TTL;
  } catch {
    return 300;
  }
}

async function redisCacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${REDIS_KEY_PREFIX}${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn('Redis cache get failed', {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function redisCacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${REDIS_KEY_PREFIX}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('Redis cache set failed', {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Sorting / deduplication helpers ─────────────────────────────────────────

const SOURCE_TRUST_ORDER: Record<ToolMetadata['source'], number> = {
  official: 4,
  enterprise: 3,
  github: 2,
  local: 1,
  unknown: 0,
};

function deduplicate(tools: ToolMetadata[]): ToolMetadata[] {
  const seen = new Map<string, ToolMetadata>();

  for (const tool of tools) {
    const existing = seen.get(tool.id);
    if (!existing) {
      seen.set(tool.id, tool);
      continue;
    }
    // Keep the higher-trust source
    const existingTrust = SOURCE_TRUST_ORDER[existing.source] ?? 0;
    const newTrust = SOURCE_TRUST_ORDER[tool.source] ?? 0;
    if (newTrust > existingTrust) {
      seen.set(tool.id, tool);
    }
  }

  return Array.from(seen.values());
}

function sortByTrustAndRelevance(tools: ToolMetadata[], query?: string): ToolMetadata[] {
  return [...tools].sort((a, b) => {
    // First: verified tools rank higher
    const aVerified = a.verified ? 1 : 0;
    const bVerified = b.verified ? 1 : 0;
    if (bVerified !== aVerified) return bVerified - aVerified;

    // Second: source trust order
    const aTrust = SOURCE_TRUST_ORDER[a.source] ?? 0;
    const bTrust = SOURCE_TRUST_ORDER[b.source] ?? 0;
    if (bTrust !== aTrust) return bTrust - aTrust;

    // Third: query relevance (name exact match > name includes > description)
    if (query && query.trim()) {
      const q = query.toLowerCase();
      const aScore =
        a.name.toLowerCase() === q ? 3 : a.name.toLowerCase().includes(q) ? 2 : 1;
      const bScore =
        b.name.toLowerCase() === q ? 3 : b.name.toLowerCase().includes(q) ? 2 : 1;
      if (bScore !== aScore) return bScore - aScore;
    }

    // Fourth: download count
    return (b.downloadCount ?? 0) - (a.downloadCount ?? 0);
  });
}

export class RegistryManager {
  private readonly registries: Map<string, Registry> = new Map();

  registerRegistry(registry: Registry): void {
    this.registries.set(registry.name, registry);
    logger.info('Registry registered', { name: registry.name });
  }

  removeRegistry(name: string): boolean {
    const existed = this.registries.delete(name);
    if (existed) logger.info('Registry removed', { name });
    return existed;
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    const start = Date.now();

    // ── Redis cache check ──────────────────────────────────────────────────
    const cacheKey = `search:${JSON.stringify(options)}`;
    const cached = await redisCacheGet<ToolMetadata[]>(cacheKey);
    if (cached) {
      logger.debug('Registry search cache hit (Redis)', { query: options.query });
      metrics.increment('registry_search_cache_hits_total');
      return cached;
    }

    const available = await this.getAvailableRegistries();

    const resultsArrays = await Promise.allSettled(
      available.map((r) => r.search(options)),
    );

    const all: ToolMetadata[] = [];
    for (let i = 0; i < resultsArrays.length; i++) {
      const result = resultsArrays[i]!;
      const registry = available[i]!;
      if (result.status === 'fulfilled') {
        all.push(...result.value);
        metrics.increment('registry_search_results_total', {
          registry: registry.name,
          count: result.value.length,
        });
      } else {
        logger.warn('Registry search failed', {
          registry: registry.name,
          err: result.reason,
        });
        metrics.increment('registry_search_errors_total', { registry: registry.name });
      }
    }

    const deduped = deduplicate(all);
    const sorted = sortByTrustAndRelevance(deduped, options.query);
    const limited = options.limit ? sorted.slice(0, options.limit) : sorted;

    metrics.histogram('registry_search_duration_ms', Date.now() - start);
    logger.info('Registry search complete', {
      query: options.query,
      total: all.length,
      deduped: deduped.length,
      returned: limited.length,
    });

    // ── Populate Redis cache ───────────────────────────────────────────────
    await redisCacheSet(cacheKey, limited, getCacheTtl());

    return limited;
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    // ── Redis cache check ──────────────────────────────────────────────────
    const cacheKey = `tool:${id}`;
    const cached = await redisCacheGet<ToolMetadata>(cacheKey);
    if (cached) {
      logger.debug('Tool lookup cache hit (Redis)', { id });
      return cached;
    }

    const available = await this.getAvailableRegistries();

    const results = await Promise.allSettled(available.map((r) => r.getById(id)));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        await redisCacheSet(cacheKey, result.value, getCacheTtl());
        return result.value;
      }
    }

    return null;
  }

  async listAll(): Promise<ToolMetadata[]> {
    // ── Redis cache check ──────────────────────────────────────────────────
    const cacheKey = 'list:all';
    const cached = await redisCacheGet<ToolMetadata[]>(cacheKey);
    if (cached) {
      logger.debug('Registry list-all cache hit (Redis)');
      metrics.increment('registry_list_cache_hits_total');
      return cached;
    }

    const available = await this.getAvailableRegistries();

    const results = await Promise.allSettled(available.map((r) => r.list()));

    const all: ToolMetadata[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const registry = available[i]!;
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      } else {
        logger.warn('Registry list failed', {
          registry: registry.name,
          err: result.reason,
        });
      }
    }

    const sorted = sortByTrustAndRelevance(deduplicate(all));

    // ── Populate Redis cache ───────────────────────────────────────────────
    await redisCacheSet(cacheKey, sorted, getCacheTtl());

    return sorted;
  }

  async discoverForCapability(capability: string): Promise<ToolMetadata[]> {
    const cap = capability.toLowerCase().trim();

    const all = await this.search({ query: cap, limit: 200 });

    const filtered = all.filter(
      (tool) =>
        tool.capabilities.some((c) => c.toLowerCase().includes(cap)) ||
        tool.tags.some((t) => t.toLowerCase().includes(cap)) ||
        tool.name.toLowerCase().includes(cap) ||
        tool.description.toLowerCase().includes(cap),
    );

    logger.info('Capability discovery complete', {
      capability,
      found: filtered.length,
    });

    return sortByTrustAndRelevance(filtered);
  }

  private async getAvailableRegistries(): Promise<Registry[]> {
    const candidates = Array.from(this.registries.values());

    const checks = await Promise.allSettled(candidates.map((r) => r.isAvailable()));

    const available: Registry[] = [];
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i]!;
      const registry = candidates[i]!;
      if (check.status === 'fulfilled' && check.value) {
        available.push(registry);
      } else {
        logger.debug('Registry unavailable, skipping', { name: registry.name });
      }
    }

    return available;
  }

  getRegistry(name: string): Registry | undefined {
    return this.registries.get(name);
  }

  listRegistries(): string[] {
    return Array.from(this.registries.keys());
  }
}

function buildRegistryManager(): RegistryManager {
  const manager = new RegistryManager();

  let enableGithub = true;
  let enableOfficial = true;
  let enableLocal = true;

  try {
    enableGithub = config.ENABLE_GITHUB_REGISTRY;
    enableOfficial = config.ENABLE_OFFICIAL_MCP_REGISTRY;
    enableLocal = config.ENABLE_LOCAL_WORKSPACE_SCAN;
  } catch {
    enableGithub = process.env['ENABLE_GITHUB_REGISTRY'] !== 'false';
    enableOfficial = process.env['ENABLE_OFFICIAL_MCP_REGISTRY'] !== 'false';
    enableLocal = process.env['ENABLE_LOCAL_WORKSPACE_SCAN'] !== 'false';
  }

  if (enableOfficial) {
    manager.registerRegistry(new OfficialRegistry());
    logger.info('Official MCP registry enabled');
  }

  if (enableGithub) {
    manager.registerRegistry(new GithubRegistry());
    logger.info('GitHub registry enabled');
  }

  if (enableLocal) {
    manager.registerRegistry(new LocalScanner());
    logger.info('Local workspace scanner enabled');
  }

  return manager;
}

export const registryManager = buildRegistryManager();
