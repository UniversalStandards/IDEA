import type { AxiosInstance } from 'axios';
import { DockerHubRegistry } from '../../src/discovery/registries/DockerHubRegistry';
import { McpRunRegistry } from '../../src/discovery/registries/McpRunRegistry';
import { NpmRegistry } from '../../src/discovery/registries/NpmRegistry';
import { PypiRegistry } from '../../src/discovery/registries/PypiRegistry';
import { SmitheryRegistry } from '../../src/discovery/registries/SmitheryRegistry';

function createHttp(getImpl: (...args: any[]) => Promise<any>): AxiosInstance {
  return { get: getImpl } as unknown as AxiosInstance;
}

describe('New discovery connectors', () => {
  it('NpmRegistry returns mcp-server packages and download counts', async () => {
    const http = createHttp(jest.fn(async (url: string) => {
      if (url.includes('/-/v1/search')) {
        return {
          data: {
            objects: [
              {
                package: {
                  name: '@scope/mcp-server-test',
                  version: '1.2.3',
                  description: 'test package',
                  keywords: ['mcp-server', 'mcp-files'],
                  links: { npm: 'https://npmjs.com/package/@scope/mcp-server-test' },
                },
              },
            ],
          },
        };
      }
      if (url.includes('/downloads/point/last-month/')) {
        return { data: { downloads: 42 } };
      }
      if (url.includes('/-/ping')) {
        return { data: { ok: true } };
      }
      return {
        data: {
          name: '@scope/mcp-server-test',
          'dist-tags': { latest: '1.2.3' },
          versions: {
            '1.2.3': {
              description: 'test package',
              keywords: ['mcp-server'],
            },
          },
        },
      };
    }));

    const registry = new NpmRegistry(http);

    const results = await registry.search({ query: 'test' });
    expect(results).toHaveLength(1);
    expect(results[0]?.downloadCount).toBe(42);
    expect(results[0]?.version).toBe('1.2.3');
    expect(await registry.healthCheck()).toBe(true);
  });

  it('SmitheryRegistry returns verified and community packages', async () => {
    const http = createHttp(jest.fn(async (url: string) => {
      if (url.endsWith('/abc')) {
        return {
          data: {
            id: 'abc',
            name: 'ABC',
            verified: true,
            community: false,
            tags: ['mcp'],
          },
        };
      }

      return {
        data: {
          packages: [
            { id: 'verified', name: 'verified-tool', verified: true, community: false },
            { id: 'community', name: 'community-tool', verified: false, community: true },
          ],
        },
      };
    }));

    const registry = new SmitheryRegistry(http);
    const results = await registry.search({ query: 'mcp' });

    expect(results).toHaveLength(2);
    expect(results.some((tool) => tool.verified)).toBe(true);
    expect(results.some((tool) => !tool.verified)).toBe(true);

    const resolved = await registry.resolve('smithery:abc');
    expect(resolved?.id).toBe('smithery:abc');
  });

  it('PypiRegistry, DockerHubRegistry and McpRunRegistry resolve tools', async () => {
    const pypiHttp = createHttp(jest.fn(async (url: string) => {
      if (url.includes('/search/')) {
        return { data: { projects: [{ name: 'mcp-pkg' }] } };
      }
      return {
        data: {
          info: { name: 'mcp-pkg', version: '0.1.0', summary: 'pkg' },
          urls: [],
        },
      };
    }));

    const dockerHttp = createHttp(jest.fn(async (url: string) => {
      if (url.includes('/search/repositories/')) {
        return { data: { results: [{ repo_name: 'team/mcp-server', pull_count: 10 }] } };
      }
      if (url.endsWith('/v2/')) return { data: {} };
      return {
        data: {
          namespace: 'team',
          name: 'mcp-server',
          pull_count: 10,
        },
      };
    }));

    const mcpRunHttp = createHttp(jest.fn(async (url: string) => {
      if (url.endsWith('/abc')) {
        return { data: { id: 'abc', name: 'mcp-run-abc' } };
      }
      return { data: { connectors: [{ id: 'abc', name: 'mcp-run-abc' }] } };
    }));

    const pypi = new PypiRegistry(pypiHttp);
    const docker = new DockerHubRegistry(dockerHttp);
    const mcprun = new McpRunRegistry(mcpRunHttp);

    expect((await pypi.search({ query: 'mcp' }))[0]?.id).toBe('pypi:mcp-pkg');
    expect((await docker.search({ query: 'mcp' }))[0]?.id).toBe('dockerhub:team/mcp-server');
    expect((await mcprun.search({ query: 'mcp' }))[0]?.id).toBe('mcprun:abc');

    expect((await pypi.resolve('pypi:mcp-pkg'))?.id).toBe('pypi:mcp-pkg');
    expect((await docker.resolve('dockerhub:team/mcp-server'))?.id).toBe('dockerhub:team/mcp-server');
    expect((await mcprun.resolve('mcprun:abc'))?.id).toBe('mcprun:abc');
  });
});
