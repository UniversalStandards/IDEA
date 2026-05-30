import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../types';

const logger = createLogger('npm-registry');

interface NpmSearchResult {
  objects?: Array<{
    package: NpmPackageSummary;
  }>;
}

interface NpmPackageSummary {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date?: string;
  links?: {
    npm?: string;
    repository?: string;
  };
  author?: {
    name?: string;
  };
  license?: string;
}

interface NpmPackageMetadata {
  name: string;
  description?: string;
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { description?: string; keywords?: string[]; author?: { name?: string } }>;
  time?: { modified?: string };
  repository?: { url?: string };
  license?: string;
}

interface NpmDownloadResponse {
  downloads?: number;
}

function toToolMetadata(
  pkg: NpmPackageSummary,
  downloads: number,
): ToolMetadata {
  const tags = [...(pkg.keywords ?? [])];
  if (!tags.includes('mcp-server')) tags.push('mcp-server');

  return {
    id: `npm:${pkg.name}`,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description ?? `MCP server package ${pkg.name}`,
    source: 'npm',
    registryUrl: pkg.links?.npm,
    repository: pkg.links?.repository,
    installCommand: `npm install ${pkg.name}`,
    capabilities: tags
      .filter((tag) => tag.startsWith('mcp-') && tag !== 'mcp-server')
      .map((tag) => tag.slice(4)),
    tags,
    author: pkg.author?.name,
    license: pkg.license,
    downloadCount: downloads,
    lastUpdated: pkg.date ? new Date(pkg.date) : undefined,
    verified: false,
    riskLevel: 'medium',
    metadata: {
      packageName: pkg.name,
      ecosystem: 'npm',
    },
  };
}

export class NpmRegistry implements Registry {
  readonly name = 'npm';

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
    if (options.source && options.source !== 'npm') return [];

    const limit = Math.min(options.limit ?? 25, 50);
    const query = [options.query.trim(), 'keywords:mcp-server'].filter(Boolean).join(' ');

    try {
      const start = Date.now();
      const response = await this.http.get<NpmSearchResult>('https://registry.npmjs.org/-/v1/search', {
        params: {
          text: query,
          size: limit,
        },
      });

      const packages = (response.data.objects ?? []).map((item) => item.package);

      const downloadResults = await Promise.allSettled(
        packages.map((pkg) =>
          this.http
            .get<NpmDownloadResponse>(
              `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg.name)}`,
            )
            .then((res) => res.data.downloads ?? 0),
        ),
      );

      const tools = packages.map((pkg, index) => {
        const download = downloadResults[index];
        const downloads = download?.status === 'fulfilled' ? download.value : 0;
        return toToolMetadata(pkg, downloads);
      });

      metrics.histogram('npm_registry_search_duration_ms', Date.now() - start);
      return tools;
    } catch (err) {
      logger.warn('npm registry search failed', {
        query: options.query,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('npm:')) return null;

    const packageName = id.slice('npm:'.length);

    try {
      const response = await this.http.get<NpmPackageMetadata>(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      );
      const latest = response.data['dist-tags']?.latest;
      if (!latest) return null;

      const version = response.data.versions?.[latest];
      const keywords = version?.keywords ?? [];

      return {
        id,
        name: response.data.name,
        version: latest,
        description: version?.description ?? response.data.description ?? '',
        source: 'npm',
        registryUrl: `https://www.npmjs.com/package/${response.data.name}`,
        repository: response.data.repository?.url,
        installCommand: `npm install ${response.data.name}`,
        capabilities: keywords
          .filter((tag) => tag.startsWith('mcp-') && tag !== 'mcp-server')
          .map((tag) => tag.slice(4)),
        tags: keywords,
        author: version?.author?.name,
        license: response.data.license,
        lastUpdated: response.data.time?.modified ? new Date(response.data.time.modified) : undefined,
        verified: false,
        riskLevel: 'medium',
        metadata: {
          packageName: response.data.name,
          ecosystem: 'npm',
        },
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    return this.search({ query: '', limit: 50, source: 'npm' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('https://registry.npmjs.org/-/ping');
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
