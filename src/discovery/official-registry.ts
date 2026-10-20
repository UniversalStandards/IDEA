/**
 * src/discovery/official-registry.ts
 * Discovery connector for the official MCP Registry
 * (https://registry.modelcontextprotocol.io, API v0) plus a curated seed list
 * of the reference servers maintained by the MCP project.
 *
 * Registry entries are mapped to launchable tools: npm packages run via
 * `npx -y <pkg>@<version>`, PyPI packages via `uvx <pkg>==<version>`. Entries
 * that only offer non-stdio transports or unsupported package types stay
 * discoverable but are marked `installable: false` with the reason.
 *
 * The seed list is always available, so discovery degrades gracefully when
 * the registry is unreachable (air-gapped deployments, outages).
 */

import axios from 'axios';
import NodeCache from 'node-cache';
import { z } from 'zod';
import { config } from '../config';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { type Registry, type RegistrySearchOptions, type ToolMetadata } from './types';

const logger = createLogger('official-registry');

export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
const LIST_CACHE_KEY = 'official:list';
const REMOTE_ID_PREFIX = 'mcp:';
const MAX_PAGE_SIZE = 100;

// ── Registry API shapes (validated leniently: unknown fields pass through) ──

const ArgumentSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    default: z.string().optional(),
    value: z.string().optional(),
  })
  .passthrough();

const EnvVarSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
  })
  .passthrough();

const PackageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string().optional(),
    runtimeHint: z.string().optional(),
    transport: z.object({ type: z.string() }).passthrough().optional(),
    packageArguments: z.array(ArgumentSchema).optional(),
    environmentVariables: z.array(EnvVarSchema).optional(),
  })
  .passthrough();

const ServerSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional(), source: z.string().optional() }).passthrough().optional(),
    packages: z.array(PackageSchema).optional(),
    remotes: z.array(z.object({ type: z.string(), url: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

const EntrySchema = z
  .object({
    server: ServerSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ListResponseSchema = z
  .object({
    servers: z.array(z.unknown()).default([]),
    metadata: z.object({ nextCursor: z.string().optional(), count: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

type RegistryEntry = z.infer<typeof EntrySchema>;
type RegistryPackage = z.infer<typeof PackageSchema>;

const SEED_TOOLS: ToolMetadata[] = [
  {
    id: 'official:filesystem',
    name: 'filesystem',
    version: '0.6.2',
    description: 'Secure file system access with configurable allowed directories (install with args listing the directories, e.g. ["/data/workspace"])',
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
    description: 'SQLite database read, write, and query capabilities (install with args ["--db-path", "/data/<file>.db"])',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers-archived',
    repository: 'https://github.com/modelcontextprotocol/servers-archived',
    installCommand: 'uvx mcp-server-sqlite',
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
    installCommand: 'uvx mcp-server-fetch',
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
  {
    id: 'official:time',
    name: 'time',
    version: '0.6.2',
    description: 'Current time and timezone conversion',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'uvx mcp-server-time',
    capabilities: ['get_current_time', 'convert_time'],
    tags: ['time', 'timezone', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 120000,
  },
  {
    id: 'official:sequential-thinking',
    name: 'sequential-thinking',
    version: '0.6.2',
    description: 'Structured, revisable step-by-step reasoning tool',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    capabilities: ['sequential_thinking'],
    tags: ['reasoning', 'thinking', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 110000,
  },
  {
    id: 'official:everything',
    name: 'everything',
    version: '0.6.2',
    description: 'Reference/test server exercising every MCP feature (tools, resources, prompts, sampling)',
    source: 'official',
    registryUrl: 'https://github.com/modelcontextprotocol/servers',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installCommand: 'npx -y @modelcontextprotocol/server-everything',
    capabilities: ['echo', 'add', 'long_running_operation', 'sample_llm'],
    tags: ['reference', 'testing', 'official'],
    author: 'modelcontextprotocol',
    license: 'MIT',
    verified: true,
    riskLevel: 'low',
    downloadCount: 100000,
  },
];

const SAFE_SPEC = /^[A-Za-z0-9@._/~^<>=*+-]+$/;

/** Command that launches a registry package as a stdio MCP server. */
export function launchCommandFor(pkg: RegistryPackage): string | undefined {
  if (pkg.transport !== undefined && pkg.transport.type !== 'stdio') return undefined;
  const version = pkg.version !== undefined && pkg.version !== '' && pkg.version !== 'latest' ? pkg.version : undefined;
  const type = pkg.registryType.toLowerCase();
  let spec: string;
  if (type === 'npm') {
    spec = version !== undefined ? `${pkg.identifier}@${version}` : pkg.identifier;
    return SAFE_SPEC.test(spec) ? `npx -y ${spec}` : undefined;
  }
  if (type === 'pypi') {
    spec = version !== undefined ? `${pkg.identifier}==${version}` : pkg.identifier;
    return SAFE_SPEC.test(spec) ? `uvx ${spec}` : undefined;
  }
  return undefined;
}

/** Map one registry entry to hub tool metadata. */
export function registryEntryToToolMetadata(entry: RegistryEntry, registryUrl: string): ToolMetadata {
  const server = entry.server;
  const meta = (entry._meta?.[OFFICIAL_META_KEY] ?? {}) as Record<string, unknown>;
  const packages = server.packages ?? [];
  const preferred =
    packages.find((p) => p.registryType.toLowerCase() === 'npm' && launchCommandFor(p) !== undefined) ??
    packages.find((p) => launchCommandFor(p) !== undefined);
  const installCommand = preferred !== undefined ? launchCommandFor(preferred) : undefined;

  const requiredEnv = (preferred?.environmentVariables ?? [])
    .filter((e) => e.isRequired === true)
    .map((e) => ({ name: e.name, secret: e.isSecret === true, description: e.description ?? '' }));
  const requiredArgs = (preferred?.packageArguments ?? [])
    .filter((a) => a.isRequired === true && a.value === undefined && a.default === undefined)
    .map((a) => ({ name: a.name ?? '', type: a.type ?? 'positional', description: a.description ?? '' }));

  let unsupportedReason: string | undefined;
  if (installCommand === undefined) {
    unsupportedReason =
      packages.length === 0 && (server.remotes?.length ?? 0) > 0
        ? 'Remote-only server (connect to its URL directly; the hub launches stdio packages)'
        : `No stdio npm/PyPI package (found: ${packages.map((p) => p.registryType).join(', ') || 'none'})`;
  }

  const updatedAt = typeof meta['updatedAt'] === 'string' ? new Date(meta['updatedAt']) : undefined;

  return {
    id: `${REMOTE_ID_PREFIX}${server.name}`,
    name: server.name,
    version: server.version ?? '0.0.0',
    description: server.description ?? server.title ?? '',
    source: 'official',
    registryUrl: `${registryUrl}/v0/servers?search=${encodeURIComponent(server.name)}`,
    ...(server.repository?.url !== undefined ? { repository: server.repository.url } : {}),
    ...(installCommand !== undefined ? { installCommand } : {}),
    capabilities: [],
    tags: ['mcp-registry', ...(preferred !== undefined ? [preferred.registryType.toLowerCase()] : [])],
    verified: false,
    riskLevel: 'medium',
    ...(updatedAt !== undefined && !Number.isNaN(updatedAt.getTime()) ? { lastUpdated: updatedAt } : {}),
    metadata: {
      registry: 'modelcontextprotocol',
      installable: installCommand !== undefined,
      ...(unsupportedReason !== undefined ? { unsupportedReason } : {}),
      ...(requiredEnv.length > 0 ? { requiredEnv } : {}),
      ...(requiredArgs.length > 0 ? { requiredArgs } : {}),
      ...(typeof meta['status'] === 'string' ? { status: meta['status'] } : {}),
    },
  };
}

function isLatestActive(entry: RegistryEntry): boolean {
  const meta = (entry._meta?.[OFFICIAL_META_KEY] ?? {}) as Record<string, unknown>;
  return meta['isLatest'] !== false && meta['status'] !== 'deleted' && meta['status'] !== 'deprecated';
}

export class OfficialRegistry implements Registry {
  readonly name = 'official';

  private readonly cache: NodeCache;
  private readonly baseUrl: string;
  /** Remote tools seen in any search, so getById after search needs no request. */
  private readonly seen = new Map<string, ToolMetadata>();

  constructor(baseUrl?: string) {
    const ttl = ((): number => {
      try {
        return config.CACHE_TTL;
      } catch {
        return 300;
      }
    })();
    this.baseUrl = (
      baseUrl ??
      ((): string => {
        try {
          return config.OFFICIAL_MCP_REGISTRY_URL;
        } catch {
          return process.env['OFFICIAL_MCP_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL;
        }
      })()
    ).replace(/\/+$/, '');

    this.cache = new NodeCache({ stdTTL: Math.max(1, ttl * 2), checkperiod: Math.max(1, ttl) });
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (options.source && options.source !== 'official') return [];

    const query = options.query.toLowerCase().trim();
    const limit = options.limit ?? MAX_PAGE_SIZE;

    const seeds = SEED_TOOLS.filter((tool) => matchesQuery(tool, query));
    const remote = query === '' ? await this.listRemote() : await this.searchRemote(query, limit);

    let results = [...seeds, ...remote.filter((r) => !seeds.some((s) => s.id === r.id))];

    const filterTags = options.tags;
    if (filterTags && filterTags.length > 0) {
      results = results.filter((tool) =>
        filterTags.some(
          (tag) => tool.tags.includes(tag.toLowerCase()) || tool.capabilities.includes(tag.toLowerCase()),
        ),
      );
    }

    return results.slice(0, limit);
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    const seed = SEED_TOOLS.find((t) => t.id === id);
    if (seed) return seed;
    const known = this.seen.get(id);
    if (known) return known;
    if (!id.startsWith(REMOTE_ID_PREFIX)) return null;

    const serverName = id.slice(REMOTE_ID_PREFIX.length);
    const matches = await this.searchRemote(serverName, MAX_PAGE_SIZE);
    return matches.find((t) => t.id === id) ?? null;
  }

  async list(): Promise<ToolMetadata[]> {
    const remote = await this.listRemote();
    return [...SEED_TOOLS, ...remote.filter((r) => !SEED_TOOLS.some((s) => s.id === r.id))];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async listRemote(): Promise<ToolMetadata[]> {
    const cached = this.cache.get<ToolMetadata[]>(LIST_CACHE_KEY);
    if (cached) return cached;
    const tools = await this.fetchServers({ limit: MAX_PAGE_SIZE });
    this.cache.set(LIST_CACHE_KEY, tools);
    return tools;
  }

  private async searchRemote(query: string, limit: number): Promise<ToolMetadata[]> {
    const key = `official:search:${query}:${limit}`;
    const cached = this.cache.get<ToolMetadata[]>(key);
    if (cached) return cached;
    const tools = await this.fetchServers({ search: query, limit: Math.min(MAX_PAGE_SIZE, Math.max(1, limit)) });
    this.cache.set(key, tools);
    return tools;
  }

  private async fetchServers(params: { search?: string; limit: number }): Promise<ToolMetadata[]> {
    const url = `${this.baseUrl}/v0/servers`;
    try {
      const start = Date.now();
      const response = await axios.get<unknown>(url, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
        // version=latest: one entry per server instead of every published version
        params: { ...params, version: 'latest' },
      });
      metrics.histogram('official_registry_fetch_duration_ms', Date.now() - start);

      const body = ListResponseSchema.parse(response.data);
      const tools: ToolMetadata[] = [];
      for (const raw of body.servers) {
        const parsed = EntrySchema.safeParse(raw);
        if (!parsed.success || !isLatestActive(parsed.data)) continue;
        const tool = registryEntryToToolMetadata(parsed.data, this.baseUrl);
        if (!tools.some((t) => t.id === tool.id)) {
          tools.push(tool);
          this.seen.set(tool.id, tool);
        }
      }
      logger.info('Fetched servers from the MCP registry', {
        search: params.search,
        returned: body.servers.length,
        mapped: tools.length,
      });
      return tools;
    } catch (err) {
      logger.warn('MCP registry unavailable; using the curated seed list only', {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
      metrics.increment('official_registry_fallback_total');
      return [];
    }
  }
}

function matchesQuery(tool: ToolMetadata, query: string): boolean {
  if (!query) return true;
  return (
    tool.name.toLowerCase().includes(query) ||
    tool.description.toLowerCase().includes(query) ||
    tool.tags.some((t) => t.toLowerCase().includes(query)) ||
    tool.capabilities.some((c) => c.toLowerCase().includes(query))
  );
}
