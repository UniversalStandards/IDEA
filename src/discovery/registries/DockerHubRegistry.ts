import axios, { type AxiosInstance } from 'axios';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { Registry, RegistrySearchOptions, ToolMetadata } from '../types';

const logger = createLogger('dockerhub-registry');

interface DockerHubSearchResponse {
  results?: Array<{
    repo_name?: string;
    short_description?: string;
    star_count?: number;
    pull_count?: number;
    last_updated?: string;
  }>;
}

interface DockerHubRepositoryResponse {
  name: string;
  namespace: string;
  description?: string | undefined;
  star_count?: number | undefined;
  pull_count?: number | undefined;
  last_updated?: string | undefined;
  media_types?: string[] | undefined;
}

function parseRepoName(repoName: string): { namespace: string; name: string } {
  if (!repoName.includes('/')) {
    return { namespace: 'library', name: repoName };
  }

  const [namespace, name] = repoName.split('/');
  return {
    namespace: namespace ?? 'library',
    name: name ?? repoName,
  };
}

function toToolMetadata(repoName: string, repo: DockerHubRepositoryResponse): ToolMetadata {
  const fullName = `${repo.namespace}/${repo.name}`;

  return {
    id: `dockerhub:${fullName}`,
    name: fullName,
    version: 'latest',
    description: repo.description ?? `Containerized MCP server ${fullName}`,
    source: 'dockerhub',
    registryUrl: `https://hub.docker.com/r/${fullName}`,
    repository: undefined,
    installCommand: `docker pull ${fullName}:latest`,
    entryPoint: undefined,
    capabilities: [],
    tags: ['docker', 'container', 'mcp-server'],
    author: repo.namespace,
    license: undefined,
    downloadCount: repo.pull_count,
    lastUpdated: repo.last_updated ? new Date(repo.last_updated) : undefined,
    verified: false,
    riskLevel: 'medium',
    metadata: {
      packageName: fullName,
      ecosystem: 'docker',
      stars: repo.star_count ?? 0,
      sourceRepoName: repoName,
    },
  };
}

export class DockerHubRegistry implements Registry {
  readonly name = 'dockerhub';

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
    if (options.source && options.source !== 'dockerhub') return [];

    const limit = Math.min(options.limit ?? 25, 50);
    const query = [options.query.trim(), 'mcp-server'].filter(Boolean).join(' ');

    try {
      const start = Date.now();
      const response = await this.http.get<DockerHubSearchResponse>(
        'https://hub.docker.com/v2/search/repositories/',
        {
          params: {
            page_size: limit,
            query,
          },
        },
      );

      const repos = (response.data.results ?? []).slice(0, limit);

      const tools = repos
        .map((repo) => {
          const repoName = repo.repo_name;
          if (!repoName) return null;

          const { namespace, name } = parseRepoName(repoName);

          return toToolMetadata(repoName, {
            namespace,
            name,
            description: repo.short_description,
            star_count: repo.star_count,
            pull_count: repo.pull_count,
            last_updated: repo.last_updated,
          });
        })
        .filter((item): item is ToolMetadata => item !== null);

      metrics.histogram('dockerhub_registry_search_duration_ms', Date.now() - start);
      return tools;
    } catch (err) {
      logger.warn('Docker Hub search failed', {
        query: options.query,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    if (!id.startsWith('dockerhub:')) return null;

    const fullName = id.slice('dockerhub:'.length);
    const [namespace, name] = fullName.split('/');
    if (!namespace || !name) return null;

    try {
      const response = await this.http.get<DockerHubRepositoryResponse>(
        `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`,
      );
      return toToolMetadata(fullName, response.data);
    } catch {
      return null;
    }
  }

  async list(): Promise<ToolMetadata[]> {
    return this.search({ query: 'mcp-server', limit: 50, source: 'dockerhub' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('https://hub.docker.com/v2/');
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
