/**
 * src/config.ts
 * Zod-validated configuration. All env vars are consumed here.
 * dotenv initialization is handled exclusively in src/env.ts (imported first
 * by src/index.ts).
 */

import { randomBytes } from 'crypto';
import path from 'path';
import { z } from 'zod';

const boolEnv = (defaultVal: boolean): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined> =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultVal;
      return v.toLowerCase() !== 'false' && v !== '0';
    });

/** Env-var string schema → number (int), falling back to `defaultVal` when unset/empty. */
type NumericEnvSchema = z.ZodPipeline<
  z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>,
  z.ZodNumber
>;

const intEnv = (
  defaultVal: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): NumericEnvSchema =>
  z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== '' ? parseInt(v, 10) : defaultVal))
    .pipe(z.number().int().min(min).max(max));

const floatEnv = (defaultVal: number, min = 0): NumericEnvSchema =>
  z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== '' ? parseFloat(v) : defaultVal))
    .pipe(z.number().min(min));

const ConfigSchema = z.object({
  // Core
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: intEnv(3000, 1, 65535),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
    .default('info'),

  // Transport
  MCP_TRANSPORT: z.enum(['stdio', 'http', 'http2', 'sse', 'websocket', 'grpc']).default('http'),
  // Streamable HTTP MCP endpoint (MCP spec 2025-06-18) served on the HTTP
  // listener. This is how network MCP clients (and the Docker Compose
  // deployment) reach the hub's tools; stdio clients do not use it.
  MCP_HTTP_ENABLED: boolEnv(true),
  MCP_HTTP_PATH: z
    .string()
    .default('/mcp')
    .refine((v) => /^\/[A-Za-z0-9/_-]*$/.test(v), {
      message: 'MCP_HTTP_PATH must be an absolute URL path such as /mcp',
    }),
  // Static bearer token for the MCP HTTP endpoint. A JWT signed with
  // JWT_SECRET is also accepted. Required in production unless
  // MCP_ALLOW_UNAUTHENTICATED=true is set explicitly.
  MCP_AUTH_TOKEN: z.string().min(32).optional(),
  MCP_ALLOW_UNAUTHENTICATED: boolEnv(false),
  // Comma-separated Host header allowlist (e.g. "localhost:3000,hub.example.com").
  // When set, DNS-rebinding protection is enforced on the MCP endpoint.
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_MAX_SESSIONS: intEnv(100, 1, 10_000),
  MCP_SESSION_IDLE_TIMEOUT_MS: intEnv(1_800_000, 60_000, 86_400_000),
  // In stdio mode the HTTP listener (health/admin/REST) is off by default so
  // several stdio instances can run side by side without port conflicts.
  STDIO_ENABLE_HTTP: boolEnv(false),

  // Downstream MCP servers (tools installed through the hub)
  DOWNSTREAM_IDLE_TIMEOUT_MS: intEnv(600_000, 10_000, 86_400_000),
  DOWNSTREAM_CONNECT_TIMEOUT_MS: intEnv(120_000, 1_000, 600_000),
  // Comma-separated tool IDs the operator pre-approves for install/execute
  // (e.g. "official:memory,official:filesystem"). Audited like any approval.
  AUTO_APPROVE_TOOLS: z.string().default(''),
  // How long an MCP-driven approval prompt (elicitation) waits for the user.
  APPROVAL_ELICITATION_TIMEOUT_MS: intEnv(120_000, 5_000, 600_000),

  // Persistent hub data (installed tools, install state). Mount a volume here
  // in containers so installs survive restarts.
  HUB_DATA_DIR: z.string().optional(),

  // AI Providers
  DEFAULT_AI_PROVIDER: z.string().default('openai'),
  FALLBACK_AI_PROVIDER: z.string().default('anthropic'),
  LOCAL_MODEL_PROVIDER: z.string().default('ollama'),
  ENABLE_MULTI_PROVIDER_ROUTING: boolEnv(true),

  // Registry Sources
  ENABLE_GITHUB_REGISTRY: boolEnv(true),
  ENABLE_OFFICIAL_MCP_REGISTRY: boolEnv(true),
  OFFICIAL_MCP_REGISTRY_URL: z.string().url().default('https://registry.modelcontextprotocol.io'),
  ENABLE_ENTERPRISE_CATALOG: boolEnv(false),
  ENABLE_LOCAL_WORKSPACE_SCAN: boolEnv(true),

  // GitHub
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
  GITHUB_BRANCH: z.string().default('main'),

  // Enterprise Catalog
  ENTERPRISE_CATALOG_URL: z.string().url().optional(),
  ENTERPRISE_CATALOG_PATH: z.string().optional(),

  // Security
  JWT_SECRET: z.string().min(32).default('change-me-in-production-must-be-32chars!!'),
  ENCRYPTION_KEY: z.string().min(32).default('change-me-in-production-must-be-32chars!!'),
  ENABLE_SIGNATURE_VALIDATION: boolEnv(true),
  CORS_ORIGIN: z
    .string()
    .default('*')
    .refine(
      (v) =>
        v === '*' ||
        v.split(',').every((o) => {
          try {
            new URL(o.trim());
            return true;
          } catch {
            return false;
          }
        }),
      { message: 'CORS_ORIGIN must be "*" or a comma-separated list of valid URLs' },
    ),

  // Policy & Governance
  ENABLE_POLICY_ENGINE: boolEnv(true),
  REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS: boolEnv(true),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: intEnv(60_000, 1000),
  RATE_LIMIT_MAX_REQUESTS: intEnv(300, 1),
  TRANSPORT_MAX_CONNECTIONS_PER_CLIENT: intEnv(25, 1),
  GRPC_PORT: intEnv(50_051, 1, 65_535),

  // Webhook / Events Adapter
  WEBHOOK_SECRET: z.string().optional(),
  EVENT_DEDUP_WINDOW_MS: intEnv(300_000, 0),

  // Cost Monitoring
  COST_TRACKING_ENABLED: boolEnv(true),
  COST_BUDGET_DAILY_USD: floatEnv(0, 0),

  // Runtime / Provisioning
  CACHE_TTL: intEnv(300, 0),
  MAX_CONCURRENT_INSTALLS: intEnv(5, 1, 100),
  // npm lifecycle scripts (preinstall/postinstall) of installed tools run
  // arbitrary code at install time; they are disabled unless opted in.
  INSTALL_ALLOW_LIFECYCLE_SCRIPTS: boolEnv(false),
  INSTALL_TIMEOUT_MS: intEnv(300_000, 10_000, 1_800_000),
  ENABLE_AUTO_UPDATES: boolEnv(false),
  ENABLE_RUNTIME_HEALTH_RECOVERY: boolEnv(true),

  // Redis (future distributed caching)
  REDIS_URL: z.string().url().optional(),

  // UpCloud Worker Factory — ephemeral browser/desktop worker sessions for
  // agents with no local device/browser linked. Off by default; see
  // docs/gates/upcloud-worker-factory.md.
  ENABLE_UPCLOUD_WORKER_FACTORY: boolEnv(false),
  UPCLOUD_BROKER_URL: z.string().url().optional(),
  UPCLOUD_BROKER_API_KEY: z.string().optional(),
  WORKER_SESSION_DEFAULT_TTL_MS: intEnv(900_000, 60_000, 14_400_000), // default 15m, floor 1m
  WORKER_SESSION_MAX_TTL_MS: intEnv(3_600_000, 60_000, 28_800_000), // default cap 1h, hard ceiling 8h
  WORKER_POOL_WARM_SIZE: intEnv(0, 0, 50),

  // Vault (AppRole auth) — dynamic secret leasing for worker sessions.
  // Credentials leased from Vault are issued into this hub's own
  // credential-broker (scoped, audited, TTL-bound) rather than read by
  // callers directly from Vault.
  VAULT_ADDR: z.string().url().optional(),
  VAULT_ROLE_ID: z.string().optional(),
  VAULT_SECRET_ID: z.string().optional(),
  VAULT_SECRET_MOUNT: z.string().default('secret'),

  // Observability
  ENABLE_METRICS: boolEnv(true),
  ENABLE_TRACING: boolEnv(true),
  ENABLE_AUDIT_LOGGING: boolEnv(true),
});

export type Config = z.infer<typeof ConfigSchema>;

const INSECURE_DEFAULT = 'change-me-in-production-must-be-32chars!!';

let _config: Config | null = null;
let _ephemeralSecrets: string[] = [];

/** True when the process speaks MCP over stdio and opens no network listener. */
export function isStdioOnly(cfg: Pick<Config, 'MCP_TRANSPORT' | 'STDIO_ENABLE_HTTP'>): boolean {
  return cfg.MCP_TRANSPORT === 'stdio' && !cfg.STDIO_ENABLE_HTTP;
}

/**
 * Names of secrets that were generated per-process because the operator did
 * not supply them (stdio-only production mode). Empty in every other mode.
 */
export function getEphemeralSecretNames(): readonly string[] {
  return _ephemeralSecrets;
}

/** Tool IDs pre-approved by the operator via AUTO_APPROVE_TOOLS. */
export function getAutoApprovedTools(cfg: Pick<Config, 'AUTO_APPROVE_TOOLS'>): ReadonlySet<string> {
  return new Set(
    cfg.AUTO_APPROVE_TOOLS.split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

/** Root directory for persistent hub data (installed tools, state files). */
export function resolveHubDataDir(cfg: Pick<Config, 'HUB_DATA_DIR'>): string {
  return path.resolve(cfg.HUB_DATA_DIR ?? path.join(process.cwd(), '.mcp'));
}

/**
 * Empty strings are treated as unset: `.env` templates and Compose
 * `${VAR:-}` interpolation produce `VAR=` for optional settings, which must
 * fall back to the default instead of failing validation (e.g. `.url()`).
 */
function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(withoutEmptyValues(process.env));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  _config = result.data;
  _ephemeralSecrets = [];

  if (_config.NODE_ENV === 'production') {
    // A stdio-only process exposes no network listener, so nothing outside
    // the process can present or forge a token signed with these secrets,
    // and neither is used to encrypt anything persisted. Generating a fresh
    // random value per process is therefore safe and lets the image run
    // unmodified under Docker MCP Toolkit / Claude Desktop. Any mode with a
    // network listener still fails fast on the insecure default.
    if (isStdioOnly(_config)) {
      if (_config.JWT_SECRET === INSECURE_DEFAULT) {
        _config.JWT_SECRET = randomBytes(48).toString('base64url');
        _ephemeralSecrets.push('JWT_SECRET');
      }
      if (_config.ENCRYPTION_KEY === INSECURE_DEFAULT) {
        _config.ENCRYPTION_KEY = randomBytes(48).toString('base64url');
        _ephemeralSecrets.push('ENCRYPTION_KEY');
      }
    }
    if (_config.JWT_SECRET === INSECURE_DEFAULT) {
      throw new Error('JWT_SECRET must be set to a strong, unique value in production');
    }
    if (_config.ENCRYPTION_KEY === INSECURE_DEFAULT) {
      throw new Error('ENCRYPTION_KEY must be set to a strong, unique value in production');
    }
    if (
      !isStdioOnly(_config) &&
      _config.MCP_HTTP_ENABLED &&
      _config.MCP_AUTH_TOKEN === undefined &&
      !_config.MCP_ALLOW_UNAUTHENTICATED
    ) {
      throw new Error(
        'MCP_AUTH_TOKEN (min 32 chars) is required in production when the MCP HTTP endpoint is enabled; ' +
          'set MCP_ALLOW_UNAUTHENTICATED=true only behind an authenticating proxy',
      );
    }
    // Block silly log level in production
    if (_config.LOG_LEVEL === 'silly') {
      throw new Error('LOG_LEVEL=silly is not permitted in NODE_ENV=production');
    }
    if (_config.ENABLE_UPCLOUD_WORKER_FACTORY) {
      if (!_config.UPCLOUD_BROKER_URL) {
        throw new Error('ENABLE_UPCLOUD_WORKER_FACTORY=true requires UPCLOUD_BROKER_URL in production');
      }
      // UPCLOUD_BROKER_API_KEY and every worker-session create/delete call
      // ride on this URL — z.string().url() alone accepts http://, which
      // would send that credential and all session traffic in cleartext.
      if (!_config.UPCLOUD_BROKER_URL.startsWith('https://')) {
        throw new Error('UPCLOUD_BROKER_URL must use https:// in production (it carries the broker API key)');
      }
      if (!_config.VAULT_ADDR || !_config.VAULT_ROLE_ID || !_config.VAULT_SECRET_ID) {
        throw new Error(
          'ENABLE_UPCLOUD_WORKER_FACTORY=true requires VAULT_ADDR, VAULT_ROLE_ID, and VAULT_SECRET_ID in production',
        );
      }
      // The AppRole secret_id, the resulting client_token, and every leased
      // secret value flow over this URL — same reasoning as above.
      if (_config.VAULT_ADDR && !_config.VAULT_ADDR.startsWith('https://')) {
        throw new Error('VAULT_ADDR must use https:// in production (it carries Vault auth tokens and leased secrets)');
      }
    }
  }

  return _config;
}

export function getConfig(): Config {
  _config ??= validateConfig();
  return _config;
}

/** Lazy proxy — reads from validated config on first access. */
export const config = new Proxy({} as Config, {
  get(_target, prop): Config[keyof Config] {
    return getConfig()[prop as keyof Config];
  },
});

/** Reset config (for testing only). */
export function _resetConfig(): void {
  _config = null;
}
