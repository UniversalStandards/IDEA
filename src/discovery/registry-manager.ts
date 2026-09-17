import { EventEmitter } from 'events';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { GithubRegistry } from './github-registry';
import { OfficialRegistry } from './official-registry';
import { LocalScanner } from './local-scanner';
import { EnterpriseRegistryAdapter } from './enterprise-catalog-adapter';
import { Registry, RegistrySearchOptions, ToolMetadata } from './types';

const logger = createLogger('registry-manager');

const SOURCE_TRUST_ORDER: Record<ToolMetadata['source'], number> = {
  official: 4,
  enterprise: 3,
  github: 2,
  local: 1,
  unknown: 0,
};

const DEFAULT_MANAGER_CACHE_TTL_MS = 60_000;

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

interface CacheEntry {
  data: ToolMetadata[];
  expiresAt: number;
}

export interface DiscoveryCompleteEvent {
  operation: 'search' | 'listAll';
  query?: string;
  resultCount: number;
  durationMs: number;
}

export class RegistryManager extends EventEmitter {
  private readonly registries: Map<string, Registry> = new Map();
  private readonly cache = new Map<string, CacheEntry>();

  registerRegistry(registry: Registry): void {
    this.registries.set(registry.name, registry);
    this.cache.clear();
    logger.info('Registry registered', { name: registry.name });
  }

  removeRegistry(name: string): boolean {
    const existed = this.registries.delete(name);
    if (existed) {
      this.cache.clear();
      logger.info('Registry removed', { name });
    }
    return existed;
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    const start = Date.now();
    const cacheKey = `search:${JSON.stringify(options)}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      logger.debug('Registry search served from manager cache', { query: options.query });
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

    const durationMs = Date.now() - start;
    metrics.histogram('registry_search_duration_ms', durationMs);
    logger.info('Registry search complete', {
      query: options.query,
      total: all.length,
      deduped: deduped.length,
      returned: limited.length,
    });

    this.setCached(cacheKey, limited);
    this.emit('discovery:complete', {
      operation: 'search',
      query: options.query,
      resultCount: limited.length,
      durationMs,
    } satisfies DiscoveryCompleteEvent);

    return limited;
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    const available = await this.getAvailableRegistries();

    const results = await Promise.allSettled(available.map((r) => r.getById(id)));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        return result.value;
      }
    }

    return null;
  }

  async listAll(): Promise<ToolMetadata[]> {
    const start = Date.now();
    const cacheKey = 'listAll';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

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
    const durationMs = Date.now() - start;

    this.setCached(cacheKey, sorted);
    this.emit('discovery:complete', {
      operation: 'listAll',
      resultCount: sorted.length,
      durationMs,
    } satisfies DiscoveryCompleteEvent);

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

  /** Clear the manager-level result cache. Called automatically when registry membership changes. */
  clearCache(): void {
    this.cache.clear();
  }

  private getCached(key: string): ToolMetadata[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private setCached(key: string, data: ToolMetadata[]): void {
    let ttlMs = DEFAULT_MANAGER_CACHE_TTL_MS;
    try {
      ttlMs = config.CACHE_TTL * 1000;
    } catch {
      // use default
    }
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
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
  let enableEnterprise = false;

  try {
    enableGithub = config.ENABLE_GITHUB_REGISTRY;
    enableOfficial = config.ENABLE_OFFICIAL_MCP_REGISTRY;
    enableLocal = config.ENABLE_LOCAL_WORKSPACE_SCAN;
    enableEnterprise = config.ENABLE_ENTERPRISE_CATALOG;
  } catch {
    enableGithub = process.env['ENABLE_GITHUB_REGISTRY'] !== 'false';
    enableOfficial = process.env['ENABLE_OFFICIAL_MCP_REGISTRY'] !== 'false';
    enableLocal = process.env['ENABLE_LOCAL_WORKSPACE_SCAN'] !== 'false';
    enableEnterprise = process.env['ENABLE_ENTERPRISE_CATALOG'] === 'true';
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

  if (enableEnterprise) {
    manager.registerRegistry(new EnterpriseRegistryAdapter());
    logger.info('Enterprise catalog registry enabled');
  }

  return manager;
}

export const registryManager = buildRegistryManager();
