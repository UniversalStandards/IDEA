/**
 * src/discovery/enterprise-catalog.ts
 * Registry connector for internal/private enterprise tool catalogs.
 * Supports both JSON-over-HTTP and local file-based catalogs.
 * Implements IRegistryConnector — same interface as github-registry.ts / official-registry.ts.
 */

import axios from 'axios';
import NodeCache from 'node-cache';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import { getConfig } from '../config';
import { RegistrySource, type DiscoveredTool, type IRegistryConnector } from '../types/index';

const logger = createLogger('enterprise-catalog');

// ─────────────────────────────────────────────────────────────────

const CatalogToolSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  packageName: z.string().optional(),
  repositoryUrl: z.string().url().optional().or(z.literal('')).transform((v) => v || undefined),
  trustScore: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).default({}),
});

const CatalogSchema = z.object({
  version: z.string().default('1'),
  name: z.string().optional(),
  tools: z.array(CatalogToolSchema),
});

type CatalogTool = z.infer<typeof CatalogToolSchema>;

// ─────────────────────────────────────────────────────────────────

export class EnterpriseCatalogConnector implements IRegistryConnector {
  readonly source = RegistrySource.ENTERPRISE;
  readonly name = 'enterprise-catalog';

  private readonly cache: NodeCache;

  constructor() {
    const cfg = getConfig();
    this.cache = new NodeCache({ stdTTL: cfg.CACHE_TTL, checkperiod: 60 });
  }

  isEnabled(): boolean {
    return getConfig().ENABLE_ENTERPRISE_CATALOG;
  }

  async discover(query?: string): Promise<DiscoveredTool[]> {
    if (!this.isEnabled()) return [];

    const cacheKey = `enterprise:${query ?? '_all'}`;
    const cached = this.cache.get<DiscoveredTool[]>(cacheKey);
    if (cached) {
      logger.debug('Enterprise catalog: cache hit', { count: cached.length, query });
      return cached;
    }

    const cfg = getConfig();
    let tools: DiscoveredTool[];

    if (cfg.ENTERPRISE_CATALOG_PATH) {
      tools = this.loadFromFile(cfg.ENTERPRISE_CATALOG_PATH);
    } else if (cfg.ENTERPRISE_CATALOG_URL) {
      tools = await this.loadFromUrl(cfg.ENTERPRISE_CATALOG_URL);
    } else {
      logger.warn(
        'Enterprise catalog enabled but neither ENTERPRISE_CATALOG_URL nor ENTERPRISE_CATALOG_PATH configured',
      );
      return [];
    }

    // Filter by query string if provided
    if (query) {
      const q = query.toLowerCase();
      tools = tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }

    this.cache.set(cacheKey, tools);
    logger.info('Enterprise catalog discovery complete', { count: tools.length, query });
    return tools;
  }

  private loadFromFile(filePath: string): DiscoveredTool[] {
    if (!existsSync(filePath)) {
      logger.warn('Enterprise catalog file not found', { filePath });
      return [];
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      const json: unknown = JSON.parse(raw);
      return this.parseCatalog(json);
    } catch (err) {
      logger.error('Failed to load enterprise catalog from file', {
        filePath,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async loadFromUrl(url: string): Promise<DiscoveredTool[]> {
    try {
      const response = await axios.get<unknown>(url, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });
      return this.parseCatalog(response.data);
    } catch (err) {
      logger.error('Failed to fetch enterprise catalog from URL', {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private parseCatalog(data: unknown): DiscoveredTool[] {
    const result = CatalogSchema.safeParse(data);
    if (!result.success) {
      logger.warn('Enterprise catalog schema validation failed', {
        issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return [];
    }
    return result.data.tools.map((t: CatalogTool) => ({
      name: t.name,
      version: t.version,
      description: t.description,
      source: RegistrySource.ENTERPRISE,
      ...(t.packageName !== undefined ? { packageName: t.packageName } : {}),
      ...(t.repositoryUrl !== undefined ? { repositoryUrl: t.repositoryUrl } : {}),
      tags: t.tags,
      ...(t.trustScore !== undefined ? { trustScore: t.trustScore } : {}),
      metadata: t.metadata,
    }));
  }
}

export const enterpriseCatalog = new EnterpriseCatalogConnector();
