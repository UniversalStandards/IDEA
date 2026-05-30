import type { Command } from 'commander';
import { renderCapabilitiesJson, renderCapabilitiesTable, type CapabilitySearchResult } from '../../utils/output';

const SMITHERY_API = 'https://registry.smithery.ai/servers';

interface SmitheryServer {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  useCount?: number;
}

interface SmitheryResponse {
  servers?: SmitheryServer[];
}

const FALLBACK_RESULTS: CapabilitySearchResult[] = [
  {
    id: '@modelcontextprotocol/server-filesystem',
    name: 'filesystem',
    description: 'Secure file system access with configurable allowed directories',
    installCommand: 'npm install -g @modelcontextprotocol/server-filesystem',
  },
  {
    id: '@modelcontextprotocol/server-github',
    name: 'github',
    description: 'GitHub repository access — files, issues, PRs, commits',
    installCommand: 'npm install -g @modelcontextprotocol/server-github',
  },
];

export async function searchCapabilities(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitySearchResult[]> {
  const normalizedQuery = query.toLowerCase().trim();

  try {
    const url = new URL(SMITHERY_API);
    url.searchParams.set('pageSize', '100');

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status}`);
    }

    const payload = (await response.json()) as SmitheryResponse;

    const results = (payload.servers ?? [])
      .map((server) => {
        const id = server.qualifiedName ?? server.displayName ?? 'unknown';
        const name = server.displayName ?? server.qualifiedName ?? 'unknown';
        return {
          id,
          name,
          description: server.description ?? 'No description',
          installCommand: `npm install -g ${id}`,
          useCount: server.useCount ?? 0,
        };
      })
      .filter((result) => {
        if (!normalizedQuery) return true;
        return (
          result.id.toLowerCase().includes(normalizedQuery) ||
          result.name.toLowerCase().includes(normalizedQuery) ||
          result.description.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, 20)
      .map(({ useCount: _useCount, ...result }) => result);

    return results.length > 0
      ? results
      : FALLBACK_RESULTS.filter((result) => {
          if (!normalizedQuery) return true;
          return (
            result.id.toLowerCase().includes(normalizedQuery) ||
            result.name.toLowerCase().includes(normalizedQuery) ||
            result.description.toLowerCase().includes(normalizedQuery)
          );
        });
  } catch {
    return FALLBACK_RESULTS.filter((result) => {
      if (!normalizedQuery) return true;
      return (
        result.id.toLowerCase().includes(normalizedQuery) ||
        result.name.toLowerCase().includes(normalizedQuery) ||
        result.description.toLowerCase().includes(normalizedQuery)
      );
    });
  }
}

export async function runCapabilitiesSearch(
  query: string,
  options: { json?: boolean },
  io: { write: (text: string) => void } = { write: (text) => process.stdout.write(`${text}\n`) },
): Promise<void> {
  const results = await searchCapabilities(query);
  io.write(options.json ? renderCapabilitiesJson(results) : renderCapabilitiesTable(results));
}

export function registerCapabilitiesSearchCommand(capsCommand: Command): void {
  capsCommand
    .command('search')
    .description('Search capability providers by query')
    .argument('<query>', 'search query, e.g. filesystem')
    .option('--json', 'output JSON instead of table')
    .action(async (query: string, options: { json?: boolean }) => {
      await runCapabilitiesSearch(query, options);
    });
}
