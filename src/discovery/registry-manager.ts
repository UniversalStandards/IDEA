import { EventEmitter } from 'events';
import NodeCache from 'node-cache';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { GithubRegistry } from './github-registry';
import { OfficialRegistry } from './official-registry';
import { LocalScanner } from './local-scanner';
import { EnterpriseCatalogConnector } from './enterprise-catalog';
import type { DiscoveredTool } from '../types/index';
import { Registry, RegistrySearchOptions, ToolMetadata } from './types';

const logger = createLogger('registry-manager');

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
    const key = `${tool.name}@${tool.version}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...tool, sources: Array.from(new Set([tool.source, ...(tool.sources ?? [])])) });
      continue;
    }
    // Merge sources — collect all registry names that provide this tool
    const mergedSources = Array.from(
      new Set([
        ...(existing.sources ?? [existing.source]),
        tool.source,
        ...(tool.sources ?? []),
      ]),
    );
    // Keep the entry from the higher-trust source
    const existingTrust = SOURCE_TRUST_ORDER[existing.source] ?? 0;
    const newTrust = SOURCE_TRUST_ORDER[tool.source] ?? 0;
    if (newTrust > existingTrust) {
      seen.set(key, { ...tool, sources: mergedSources });
    } else {
      seen.set(key, { ...existing, sources: mergedSources });
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

const LIST_ALL_CACHE_KEY = 'manager:listAll';

/** Adapts EnterpriseCatalogConnector (IRegistryConnector) to the Registry interface. */
class EnterpriseCatalogRegistryAdapter implements Registry {
  readonly name = 'enterprise-catalog';

  constructor(private readonly connector: EnterpriseCatalogConnector) {}

  async isAvailable(): Promise<boolean> {
    return this.connector.isEnabled();
  }

  async list(): Promise<ToolMetadata[]> {
    const tools = await this.connector.discover();
    return tools.map((t) => this.toToolMetadata(t));
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    const tools = await this.connector.discover(options.query);
    const mapped = tools.map((t) => this.toToolMetadata(t));
    return options.limit ? mapped.slice(0, options.limit) : mapped;
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    const tools = await this.connector.discover();
    const found = tools.find(
      (t) => `enterprise:${t.name}@${t.version}` === id || t.name === id,
    );
    return found ? this.toToolMetadata(found) : null;
  }

  private toToolMetadata(tool: DiscoveredTool): ToolMetadata {
    const meta: ToolMetadata = {
      id: `enterprise:${tool.name}@${tool.version}`,
      name: tool.name,
      version: tool.version,
      description: tool.description,
      source: 'enterprise',
      capabilities: [],
      tags: tool.tags,
      verified: false,
      riskLevel: 'low',
      metadata: tool.metadata,
    };
    if (tool.repositoryUrl !== undefined) {
      meta.registryUrl = tool.repositoryUrl;
      meta.repository = tool.repositoryUrl;
    }
    return meta;
  }
}

export class RegistryManager extends EventEmitter {
  private readonly registries: Map<string, Registry> = new Map();
  private readonly cache: NodeCache;

  constructor() {
    super();
    let ttl = 300;
    try {
      ttl = config.CACHE_TTL;
    } catch {
      const parsed = parseInt(process.env['CACHE_TTL'] ?? '300', 10);
      ttl = Number.isNaN(parsed) ? 300 : parsed;
    }
    this.cache = new NodeCache({ stdTTL: ttl, checkperiod: 60 });
  }

  /** Invalidate the manager-level listAll cache (e.g. after a registry is registered/removed). */
  invalidateCache(): void {
    this.cache.del(LIST_ALL_CACHE_KEY);
  }

  registerRegistry(registry: Registry): void {
    this.registries.set(registry.name, registry);
    this.cache.del(LIST_ALL_CACHE_KEY);
    logger.info('Registry registered', { name: registry.name });
  }

  removeRegistry(name: string): boolean {
    const existed = this.registries.delete(name);
    if (existed) {
      this.cache.del(LIST_ALL_CACHE_KEY);
      logger.info('Registry removed', { name });
    }
    return existed;
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    const start = Date.now();

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
    const cached = this.cache.get<ToolMetadata[]>(LIST_ALL_CACHE_KEY);
    if (cached) {
      logger.debug('Registry manager cache hit (listAll)', { count: cached.length });
      return cached;
    }

    const start = Date.now();
    const available = await this.getAvailableRegistries();
    const sourceNames = available.map((r) => r.name);

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
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          stack: result.reason instanceof Error ? result.reason.stack : undefined,
        });
      }
    }

    const deduped = sortByTrustAndRelevance(deduplicate(all));
    const durationMs = Date.now() - start;

    this.cache.set(LIST_ALL_CACHE_KEY, deduped);

    this.emit('discovery:complete', { count: deduped.length, durationMs, sources: sourceNames });
    logger.info('Discovery complete', { count: deduped.length, durationMs, sources: sourceNames });

    return deduped;
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
    manager.registerRegistry(new EnterpriseCatalogRegistryAdapter(new EnterpriseCatalogConnector()));
    logger.info('Enterprise catalog enabled');
  }

  return manager;
}

export const registryManager = buildRegistryManager();
