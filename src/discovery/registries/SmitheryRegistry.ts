import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../types';

const logger = createLogger('smithery-registry');

interface SmitheryPackage {
  id?: string;
  slug?: string;
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: string;
  tags?: string[];
  capabilities?: string[];
  author?: string;
  license?: string;
  verified?: boolean;
  installCommand?: string;
  downloads?: number;
  updatedAt?: string;
  community?: boolean;
}

interface SmitheryPackageListResponse {
  packages?: SmitheryPackage[];
}

function toToolMetadata(pkg: SmitheryPackage): ToolMetadata {
  const identifier = pkg.slug ?? pkg.id ?? pkg.name ?? 'unknown';
  const packageName = pkg.slug ?? pkg.name ?? identifier;

  return {
    id: `smithery:${identifier}`,
    name: pkg.name ?? packageName,
    version: pkg.version ?? '0.0.0',
    description: pkg.description ?? `Smithery MCP package ${packageName}`,
    source: 'smithery',
    registryUrl: pkg.homepage ?? `https://smithery.ai/packages/${packageName}`,
    repository: pkg.repository,
    installCommand: pkg.installCommand,
    capabilities: pkg.capabilities ?? [],
    tags: pkg.tags ?? ['mcp'],
    author: pkg.author,
    license: pkg.license,
    downloadCount: pkg.downloads,
    lastUpdated: pkg.updatedAt ? new Date(pkg.updatedAt) : undefined,
    verified: pkg.verified,
    riskLevel: pkg.verified ? 'low' : 'medium',
    metadata: {
      packageName,
      ecosystem: 'smithery',
      community: pkg.community ?? !pkg.verified,
    },
  };
}

export class SmitheryRegistry implements Registry {
  readonly name = 'smithery';

  private readonly http: AxiosInstance;

  constructor(http?: AxiosInstance) {
    this.http =
      http ??
      axios.create({
        timeout: 2500,
        headers: { Accept: 'application/json' },
      });
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (options.source && options.source !== 'smithery') return [];

    const limit = Math.min(options.limit ?? 50, 100);

    try {
      const start = Date.now();
      const response = await this.http.get<SmitheryPackageListResponse>(
        'https://smithery.ai/api/v1/packages',
        {
          params: {
            q: options.query.trim(),
            limit,
            includeCommunity: true,
            includeVerified: true,
          },
        },
      );

      const tools = (response.data.packages ?? []).map(toToolMetadata).slice(0, limit);
      metrics.histogram('smithery_registry_search_duration_ms', Date.now() - start);
      return tools;
    } catch (err) {
      logger.warn('Smithery registry search failed', {
        query: options.query,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('smithery:')) return null;

    const packageId = id.slice('smithery:'.length);

    try {
      const response = await this.http.get<SmitheryPackage>(
        `https://smithery.ai/api/v1/packages/${encodeURIComponent(packageId)}`,
      );
      return toToolMetadata(response.data);
    } catch {
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    return this.search({ query: '', limit: 100, source: 'smithery' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('https://smithery.ai/api/v1/packages', {
        params: { limit: 1 },
      });
      return true;
    } catch {
      return false;
    }
  }

  async resolve(id: string): Promise<ToolMetadata | null> {
    return this.getById(id);
  }

  async healthCheck(): Promise<boolean> {
    return this.isAvailable();
  }
}
