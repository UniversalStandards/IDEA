import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../types';

const logger = createLogger('mcprun-registry');

interface McpRunConnector {
  id?: string;
  slug?: string;
  name?: string;
  version?: string;
  description?: string;
  tags?: string[];
  capabilities?: string[];
  author?: string;
  homepage?: string;
  repository?: string;
  verified?: boolean;
  installs?: number;
  updatedAt?: string;
}

interface McpRunListResponse {
  connectors?: McpRunConnector[];
}

function toToolMetadata(connector: McpRunConnector): ToolMetadata {
  const identifier = connector.id ?? connector.slug ?? connector.name ?? 'unknown';
  const packageName = connector.slug ?? connector.name ?? identifier;

  return {
    id: `mcprun:${identifier}`,
    name: connector.name ?? packageName,
    version: connector.version ?? '0.0.0',
    description: connector.description ?? `mcp.run connector ${packageName}`,
    source: 'mcprun',
    registryUrl: connector.homepage ?? `https://mcp.run/connectors/${packageName}`,
    repository: connector.repository,
    installCommand: `mcp-run install ${packageName}`,
    capabilities: connector.capabilities ?? [],
    tags: connector.tags ?? ['mcp'],
    author: connector.author,
    license: undefined,
    downloadCount: connector.installs,
    lastUpdated: connector.updatedAt ? new Date(connector.updatedAt) : undefined,
    verified: connector.verified ?? false,
    riskLevel: connector.verified ? 'low' : 'medium',
    metadata: {
      packageName,
      ecosystem: 'mcprun',
    },
  };
}

export class McpRunRegistry implements Registry {
  readonly name = 'mcprun';

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
    if (options.source && options.source !== 'mcprun') return [];

    const limit = Math.min(options.limit ?? 50, 100);

    try {
      const start = Date.now();
      const response = await this.http.get<McpRunListResponse>('https://mcp.run/api/v1/connectors', {
        params: {
          q: options.query.trim(),
          limit,
        },
      });

      const tools = (response.data.connectors ?? []).map(toToolMetadata).slice(0, limit);
      metrics.histogram('mcprun_registry_search_duration_ms', Date.now() - start);
      return tools;
    } catch (err) {
      logger.warn('mcp.run search failed', {
        query: options.query,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('mcprun:')) return null;

    const connectorId = id.slice('mcprun:'.length);

    try {
      const response = await this.http.get<McpRunConnector>(
        `https://mcp.run/api/v1/connectors/${encodeURIComponent(connectorId)}`,
      );
      return toToolMetadata(response.data);
    } catch {
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    return this.search({ query: '', limit: 100, source: 'mcprun' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('https://mcp.run/api/v1/connectors', { params: { limit: 1 } });
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
