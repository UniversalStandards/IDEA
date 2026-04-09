import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../observability/logger';
import { Registry, RegistrySearchOptions, ToolMetadata } from './types';

const logger = createLogger('local-scanner');

const DEFAULT_SCAN_PATHS = [
  path.resolve(process.cwd(), 'plugins'),
  path.resolve(process.cwd(), 'adapters'),
  path.resolve(os.homedir(), '.mcp', 'tools'),
];

interface McpManifest {
  name?: string;
  version?: string;
  description?: string;
  mcp?: boolean | Record<string, unknown>;
  'mcp-server'?: boolean | Record<string, unknown>;
  main?: string;
  bin?: string | Record<string, string>;
  keywords?: string[];
  author?: string | { name: string };
  license?: string;
  dependencies?: Record<string, string>;
  capabilities?: string[];
  tags?: string[];
  entryPoint?: string;
}

function isMcpManifest(manifest: McpManifest): boolean {
  if (manifest['mcp'] === true) return true;
  if (manifest['mcp-server'] === true) return true;
  if (typeof manifest['mcp'] === 'object' && manifest['mcp'] !== null) return true;
  if (typeof manifest['mcp-server'] === 'object' && manifest['mcp-server'] !== null) return true;
  return false;
}

function resolveAuthor(author: string | { name: string } | undefined): string | undefined {
  if (!author) return undefined;
  if (typeof author === 'string') return author;
  return author.name;
}

function resolveEntryPoint(manifest: McpManifest, manifestDir: string): string | undefined {
  if (manifest.entryPoint) return path.resolve(manifestDir, manifest.entryPoint);
  if (manifest.main) return path.resolve(manifestDir, manifest.main);
  if (typeof manifest.bin === 'string') return path.resolve(manifestDir, manifest.bin);
  if (typeof manifest.bin === 'object' && manifest.bin !== null) {
    const first = Object.values(manifest.bin)[0];
    if (first) return path.resolve(manifestDir, first);
  }
  return undefined;
}

function manifestToToolMetadata(
  manifest: McpManifest,
  manifestPath: string,
): ToolMetadata {
  const manifestDir = path.dirname(manifestPath);
  const name = manifest.name ?? path.basename(manifestDir);
  const id = `local:${name}`;

  const mcpConfig =
    typeof manifest['mcp'] === 'object' && manifest['mcp'] !== null
      ? (manifest['mcp'] as Record<string, unknown>)
      : typeof manifest['mcp-server'] === 'object' && manifest['mcp-server'] !== null
        ? (manifest['mcp-server'] as Record<string, unknown>)
        : {};

  const capabilities: string[] = Array.isArray(mcpConfig['capabilities'])
    ? (mcpConfig['capabilities'] as string[])
    : Array.isArray(manifest.capabilities)
      ? manifest.capabilities
      : [];

  const tags: string[] = Array.isArray(manifest.keywords)
    ? manifest.keywords
    : Array.isArray(manifest.tags)
      ? manifest.tags
      : [];

  if (!tags.includes('local')) tags.push('local');

  const dependencies = manifest.dependencies ? Object.keys(manifest.dependencies) : [];

  return {
    id,
    name,
    version: manifest.version ?? '0.0.0',
    description: manifest.description ?? `Local MCP server: ${name}`,
    source: 'local',
    entryPoint: resolveEntryPoint(manifest, manifestDir),
    capabilities,
    tags,
    author: resolveAuthor(manifest.author),
    license: manifest.license,
    verified: false,
    riskLevel: 'low',
    dependencies,
    metadata: {
      manifestPath,
      manifestDir,
      ...mcpConfig,
    },
  };
}

function readManifest(filePath: string): McpManifest | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as McpManifest;
  } catch (err) {
    logger.debug('Failed to read manifest', {
      filePath,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function scanDirectory(dir: string): ToolMetadata[] {
  if (!fs.existsSync(dir)) return [];

  const results: ToolMetadata[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.debug('Cannot read directory', {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.name === 'mcp.json') {
      const manifest = readManifest(entryPath);
      if (manifest) {
        const tool = manifestToToolMetadata(manifest, entryPath);
        results.push(tool);
        logger.debug('Found mcp.json manifest', { path: entryPath, id: tool.id });
      }
      continue;
    }

    if (entry.name === 'package.json') {
      const manifest = readManifest(entryPath);
      if (manifest && isMcpManifest(manifest)) {
        const tool = manifestToToolMetadata(manifest, entryPath);
        results.push(tool);
        logger.debug('Found MCP-enabled package.json', { path: entryPath, id: tool.id });
      }
      continue;
    }

    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...scanDirectory(entryPath));
    }
  }

  return results;
}

export class LocalScanner implements Registry {
  readonly name = 'local';

  private readonly scanPaths: string[];
  private tools: Map<string, ToolMetadata> = new Map();
  private watchers: fs.FSWatcher[] = [];
  private initialized = false;

  constructor(scanPaths: string[] = DEFAULT_SCAN_PATHS) {
    this.scanPaths = scanPaths;
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.rescan();
    this.startWatching();
  }

  private rescan(): void {
    const found = new Map<string, ToolMetadata>();

    for (const dir of this.scanPaths) {
      const tools = scanDirectory(dir);
      for (const tool of tools) {
        found.set(tool.id, tool);
      }
    }

    this.tools = found;
    logger.info('Local scan complete', { count: found.size, paths: this.scanPaths });
  }

  private startWatching(): void {
    for (const dir of this.scanPaths) {
      if (!fs.existsSync(dir)) continue;

      try {
        const watcher = fs.watch(
          dir,
          { recursive: true, persistent: false },
          (eventType, filename) => {
            if (filename && (filename.endsWith('mcp.json') || filename.endsWith('package.json'))) {
              logger.debug('File change detected, rescanning', { dir, filename, eventType });
              this.rescan();
            }
          },
        );
        this.watchers.push(watcher);
        logger.debug('Watching directory for changes', { dir });
      } catch (err) {
        logger.debug('Cannot watch directory', {
          dir,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  stopWatching(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    if (options.source && options.source !== 'local') return [];
    this.initialize();

    const query = options.query.toLowerCase().trim();
    const all = Array.from(this.tools.values());

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
      results = results.filter((tool) =>
        options.tags!.some(
          (tag) =>
            tool.tags.includes(tag.toLowerCase()) ||
            tool.capabilities.includes(tag.toLowerCase()),
        ),
      );
    }

    return results.slice(0, options.limit ?? results.length);
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    this.initialize();
    return this.tools.get(id) ?? null;
  }

  async list(): Promise<ToolMetadata[]> {
    this.initialize();
    return Array.from(this.tools.values());
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  forceRescan(): void {
    this.rescan();
  }
}
