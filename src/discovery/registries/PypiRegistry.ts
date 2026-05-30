import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../types';

const logger = createLogger('pypi-registry');

interface PypiSearchResponse {
  projects?: Array<{
    name: string;
    version?: string;
    summary?: string;
    keywords?: string;
  }>;
}

interface PypiProjectResponse {
  info: {
    name: string;
    version: string;
    summary?: string;
    keywords?: string;
    author?: string;
    license?: string;
    package_url?: string;
    project_urls?: Record<string, string>;
    classifiers?: string[];
  };
  urls?: Array<{
    upload_time_iso_8601?: string;
    downloads?: number;
  }>;
}

function splitKeywords(keywords: string | undefined): string[] {
  if (!keywords) return [];
  return keywords
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function toToolMetadata(project: PypiProjectResponse): ToolMetadata {
  const tags = splitKeywords(project.info.keywords);
  if (!tags.includes('mcp')) tags.push('mcp');

  const uploadTimes = (project.urls ?? [])
    .map((item) => item.upload_time_iso_8601)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));

  const latestUpload = uploadTimes.length > 0 ? new Date(Math.max(...uploadTimes)) : undefined;

  return {
    id: `pypi:${project.info.name}`,
    name: project.info.name,
    version: project.info.version,
    description: project.info.summary ?? `MCP server package ${project.info.name}`,
    source: 'pypi',
    registryUrl: project.info.package_url,
    repository: project.info.project_urls?.['Source'],
    installCommand: `pip install ${project.info.name}`,
    capabilities: (project.info.classifiers ?? [])
      .filter((item) => item.toLowerCase().includes('mcp'))
      .map((item) => item.split('::').pop()?.trim() ?? item),
    tags,
    author: project.info.author,
    license: project.info.license,
    downloadCount: undefined,
    lastUpdated: latestUpload,
    verified: false,
    riskLevel: 'medium',
    metadata: {
      packageName: project.info.name,
      ecosystem: 'pypi',
      classifiers: project.info.classifiers ?? [],
    },
  };
}

export class PypiRegistry implements Registry {
  readonly name = 'pypi';

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
    if (options.source && options.source !== 'pypi') return [];

    const query = [options.query.trim(), 'mcp'].filter(Boolean).join(' ');
    const limit = Math.min(options.limit ?? 25, 50);

    try {
      const start = Date.now();
      const response = await this.http.get<PypiSearchResponse>('https://pypi.org/search/', {
        params: {
          q: query,
          format: 'json',
        },
      });

      const projects = (response.data.projects ?? [])
        .filter((project) => {
          const searchable = `${project.name} ${project.summary ?? ''} ${project.keywords ?? ''}`.toLowerCase();
          return searchable.includes('mcp');
        })
        .slice(0, limit);

      const resolved = await Promise.allSettled(
        projects.map((project) =>
          this.http
            .get<PypiProjectResponse>(`https://pypi.org/pypi/${encodeURIComponent(project.name)}/json`)
            .then((result) => toToolMetadata(result.data)),
        ),
      );

      metrics.histogram('pypi_registry_search_duration_ms', Date.now() - start);

      return resolved
        .filter((result): result is PromiseFulfilledResult<ToolMetadata> => result.status === 'fulfilled')
        .map((result) => result.value);
    } catch (err) {
      logger.warn('PyPI registry search failed', {
        query: options.query,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('pypi:')) return null;

    const packageName = id.slice('pypi:'.length);

    try {
      const response = await this.http.get<PypiProjectResponse>(
        `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
      );
      return toToolMetadata(response.data);
    } catch {
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    return this.search({ query: 'mcp', limit: 50, source: 'pypi' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('https://pypi.org/pypi/pip/json');
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
