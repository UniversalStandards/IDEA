import axios from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { type Registry, type RegistrySearchOptions, type ToolMetadata } from './types';

const logger = createLogger('official-registry');

const SMITHERY_API = 'https://registry.smithery.ai/servers';
const CACHE_KEY = 'official:all';

interface SmitheryServer {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  iconUrl?: string;
  isDeployed?: boolean;
  createdAt?: string;
  useCount?: number;
}

interface SmitheryResponse {
  servers?: SmitheryServer[];
  pageInfo?: {
    totalCount?: number;
  };
}

const SEED_TOOLS: ToolMetadata[] = [
  {
    id: 'official:filesystem',
    name: 'filesystem',
    version: '0.6.2',
    description: 'Secure file system access with configurable allowed directories',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-filesystem',
    capabilities: ['read_file', 'write_file', 'list_directory', 'create_directory', 'delete'],
    tags: ['filesystem', 'files', 'io', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'medium',
    downloadCount: 500000,
  },
  {
    id: 'official:github',
    name: 'github',
    version: '0.6.2',
    description: 'GitHub repository access — files, issues, PRs, commits',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-github',
    capabilities: ['read_file', 'list_repository', 'create_issue', 'create_pr', 'search_code'],
    tags: ['github', 'git', 'vcs', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'medium',
    downloadCount: 400000,
  },
  {
    id: 'official:web-search',
    name: 'web-search',
    version: '0.6.2',
    description: 'Brave Search API integration for web and local search',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-brave-search',
    capabilities: ['web_search', 'local_search'],
    tags: ['search', 'web', 'brave', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 350000,
  },
  {
    id: 'official:sqlite',
    name: 'sqlite',
    version: '0.6.2',
    description: 'SQLite database read, write, and query capabilities',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-sqlite',
    capabilities: ['query', 'execute', 'list_tables', 'describe_table'],
    tags: ['database', 'sqlite', 'sql', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'medium',
    downloadCount: 300000,
  },
  {
    id: 'official:postgres',
    name: 'postgres',
    version: '0.6.2',
    description: 'PostgreSQL read-only query capabilities with schema inspection',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-postgres',
    capabilities: ['query', 'list_tables', 'describe_table'],
    tags: ['database', 'postgres', 'postgresql', 'sql', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'medium',
    downloadCount: 280000,
  },
  {
    id: 'official:slack',
    name: 'slack',
    version: '0.6.2',
    description: 'Slack workspace integration — channels, messages, users',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-slack',
    capabilities: ['send_message', 'read_channel', 'list_channels', 'list_users'],
    tags: ['slack', 'messaging', 'communication', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 250000,
  },
  {
    id: 'official:memory',
    name: 'memory',
    version: '0.6.2',
    description: 'Persistent knowledge graph memory across conversations',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-memory',
    capabilities: ['store_memory', 'retrieve_memory', 'search_memory', 'delete_memory'],
    tags: ['memory', 'knowledge-graph', 'persistence', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 220000,
  },
  {
    id: 'official:puppeteer',
    name: 'puppeteer',
    version: '0.6.2',
    description: 'Browser automation via Puppeteer — navigate, click, screenshot',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-puppeteer',
    capabilities: ['navigate', 'click', 'screenshot', 'evaluate', 'fill_form'],
    tags: ['browser', 'puppeteer', 'automation', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'high',
    downloadCount: 200000,
  },
  {
    id: 'official:fetch',
    name: 'fetch',
    version: '0.6.2',
    description: 'HTTP/HTTPS URL fetching with content extraction',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-fetch',
    capabilities: ['fetch_url', 'extract_content'],
    tags: ['http', 'fetch', 'web', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 180000,
  },
  {
    id: 'official:google-maps',
    name: 'google-maps',
    version: '0.6.2',
    description: 'Google Maps API integration — geocoding, places, directions',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-google-maps',
    capabilities: ['geocode', 'places_search', 'directions'],
    tags: ['maps', 'geolocation', 'google', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 150000,
  },
];

function smitheryToToolMetadata(server: SmitheryServer): ToolMetadata {
  const id = `official:${server.qualifiedName ?? server.displayName ?? 'unknown'}`;
  return {
    id,
    name: server.displayName ?? server.qualifiedName ?? 'unknown',
    version: '0.0.0',
    description: server.description ?? '',
    source: 'official',
    registryUrl: server.homepage ?? SMITHERY_API,
    capabilities: [],
    tags: ['smithery'],
    verified: server.isDeployed === true,
    riskLevel: 'low',
    downloadCount: server.useCount ?? 0,
    ...(server.createdAt ? { lastUpdated: new Date(server.createdAt) } : {}),
  };
}

export class OfficialRegistry implements Registry {
  readonly name = 'official';

  private readonly cache: NodeCache;

  constructor() {
    const ttl = ((): number => {
      try {
        return config.CACHE_TTL;
      } catch {
        return 300;
      }
    })();

    this.cache = new NodeCache({ stdTTL: ttl * 2, checkperiod: ttl });
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (options.source && options.source !== 'official') return [];

    const all = await this.list();
    const query = options.query.toLowerCase().trim();

    let results = all.filter((tool) => {
      if (!query) return true;
      return (
        tool.name.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query) ||
        tool.tags.some((t) => t.toLowerCase().includes(query)) ||
        tool.capabilities.some((c) => c.toLowerCase().includes(query))
      );
    });

    if (options.tags && options.tags.length > 0) {
      const { tags } = options;
      results = results.filter((tool) =>
        tags.some(
          (tag) =>
            tool.tags.includes(tag.toLowerCase()) ||
            tool.capabilities.includes(tag.toLowerCase()),
        ),
      );
    }

    return results.slice(0, options.limit ?? results.length);
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    const all = await this.list();
    return all.find((t) => t.id === id) ?? null;
  }

  async list(): Promise<ToolMetadata[]> {
    const cached = this.cache.get<ToolMetadata[]>(CACHE_KEY);
    if (cached) return cached;

    const tools = await this.fetchFromSmithery();
    this.cache.set(CACHE_KEY, tools);
    return tools;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async fetchFromSmithery(): Promise<ToolMetadata[]> {
    try {
      const start = Date.now();
      const response = await axios.get<SmitheryResponse>(SMITHERY_API, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
        params: { pageSize: 100 },
      });

      metrics.histogram('official_registry_fetch_duration_ms', Date.now() - start);

      const remoteTools: ToolMetadata[] = (response.data.servers ?? []).map(
        smitheryToToolMetadata,
      );

      const merged = this.mergeWithSeed(remoteTools);
      logger.info('Fetched official registry from Smithery', {
        remote: remoteTools.length,
        total: merged.length,
      });

      return merged;
    } catch (err) {
      logger.warn('Could not fetch from Smithery registry, using seed list', {
        err: err instanceof Error ? err.message : String(err),
      });
      metrics.increment('official_registry_fallback_total');
      return [...SEED_TOOLS];
    }
  }

  private mergeWithSeed(remote: ToolMetadata[]): ToolMetadata[] {
    const byId = new Map<string, ToolMetadata>();

    for (const tool of SEED_TOOLS) {
      byId.set(tool.id, tool);
    }

    for (const tool of remote) {
      if (!byId.has(tool.id)) {
        byId.set(tool.id, tool);
      }
    }

    return Array.from(byId.values());
  }
}
