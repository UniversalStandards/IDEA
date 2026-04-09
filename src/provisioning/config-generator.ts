import * as path from 'path';
import { createLogger } from '../observability/logger';
import { ToolMetadata } from '../discovery/types';

const logger = createLogger('config-generator');

export interface ToolRuntimeConfig {
  env: Record<string, string>;
  args: string[];
  workingDir: string;
  timeout: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TOOLS_BASE_DIR = path.resolve(process.cwd(), '.mcp', 'tools');

const ENV_CREDENTIAL_KEYS: Record<string, string[]> = {
  github: ['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  postgres: ['POSTGRES_URL', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
  sqlite: ['SQLITE_DB_PATH'],
  'web-search': ['BRAVE_API_KEY'],
  'google-maps': ['GOOGLE_MAPS_API_KEY'],
  fetch: [],
  filesystem: ['ALLOWED_DIRECTORIES'],
  memory: ['MEMORY_FILE_PATH'],
  puppeteer: ['PUPPETEER_EXECUTABLE_PATH'],
};

function resolveWorkingDir(tool: ToolMetadata): string {
  if (tool.entryPoint) {
    return path.dirname(tool.entryPoint);
  }
  return path.join(TOOLS_BASE_DIR, tool.name);
}

function resolveTimeout(tool: ToolMetadata): number {
  const metaTimeout = tool.metadata?.['timeout'];
  if (typeof metaTimeout === 'number' && metaTimeout > 0) {
    return metaTimeout;
  }

  // Higher timeout for browser automation tools
  if (tool.capabilities.some((c) => ['navigate', 'screenshot', 'evaluate'].includes(c))) {
    return 60_000;
  }

  return DEFAULT_TIMEOUT_MS;
}

function buildEnv(tool: ToolMetadata, credentials: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  // Inject credentials by key
  for (const [key, value] of Object.entries(credentials)) {
    env[key] = value;
  }

  // Auto-map credential hints based on tool name
  const credKeys = ENV_CREDENTIAL_KEYS[tool.name] ?? [];
  for (const key of credKeys) {
    if (process.env[key] && !env[key]) {
      env[key] = process.env[key]!;
    }
  }

  // Merge any env overrides from tool metadata
  const metaEnv = tool.metadata?.['env'];
  if (typeof metaEnv === 'object' && metaEnv !== null) {
    for (const [k, v] of Object.entries(metaEnv)) {
      if (typeof v === 'string' && !env[k]) {
        env[k] = v;
      }
    }
  }

  return env;
}

function buildArgs(tool: ToolMetadata): string[] {
  const metaArgs = tool.metadata?.['args'];
  if (Array.isArray(metaArgs)) {
    return metaArgs.filter((a): a is string => typeof a === 'string');
  }
  return [];
}

export class ConfigGenerator {
  generate(tool: ToolMetadata, credentials: Record<string, string>): ToolRuntimeConfig {
    const cfg: ToolRuntimeConfig = {
      env: buildEnv(tool, credentials),
      args: buildArgs(tool),
      workingDir: resolveWorkingDir(tool),
      timeout: resolveTimeout(tool),
    };

    logger.debug('Runtime config generated', {
      toolId: tool.id,
      workingDir: cfg.workingDir,
      timeout: cfg.timeout,
      envKeys: Object.keys(cfg.env),
    });

    return cfg;
  }

  generateClientConfig(tools: ToolMetadata[]): object {
    const mcpServers: Record<string, unknown> = {};

    for (const tool of tools) {
      const cfg = this.generate(tool, {});
      const serverKey = tool.name.replace(/[^a-zA-Z0-9_-]/g, '-');

      const command = this.resolveCommand(tool);
      if (!command) {
        logger.debug('Skipping tool with no resolved command', { toolId: tool.id });
        continue;
      }

      mcpServers[serverKey] = {
        command: command.cmd,
        args: [...command.args, ...cfg.args],
        env: Object.keys(cfg.env).length > 0 ? cfg.env : undefined,
      };
    }

    return { mcpServers };
  }

  private resolveCommand(tool: ToolMetadata): { cmd: string; args: string[] } | null {
    if (tool.installCommand) {
      const parts = tool.installCommand.trim().split(/\s+/);
      const cmd = parts[0];
      if (!cmd) return null;
      return { cmd, args: parts.slice(1) };
    }

    if (tool.entryPoint) {
      return { cmd: 'node', args: [tool.entryPoint] };
    }

    if (tool.source === 'local' && tool.name) {
      return { cmd: 'node', args: [path.join(TOOLS_BASE_DIR, tool.name, 'index.js')] };
    }

    const metaCmd = tool.metadata?.['command'];
    if (typeof metaCmd === 'string') {
      const parts = metaCmd.trim().split(/\s+/);
      const cmd = parts[0];
      if (!cmd) return null;
      return { cmd, args: parts.slice(1) };
    }

    return null;
  }
}

export const configGenerator = new ConfigGenerator();
