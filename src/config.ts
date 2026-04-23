/**
 * src/config.ts
 * Zod-validated configuration. All env vars are consumed here.
 * dotenv initialization is handled exclusively in src/index.ts.
 */

import { z } from 'zod';

const boolEnv = (defaultVal: boolean): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined> =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultVal;
      return v.toLowerCase() !== 'false' && v !== '0';
    });

const intEnv = (defaultVal: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== '' ? parseInt(v, 10) : defaultVal))
    .pipe(z.number().int().min(min).max(max));

const floatEnv = (defaultVal: number, min = 0) =>
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
  MCP_TRANSPORT: z.enum(['stdio', 'http', 'sse']).default('http'),

  // AI Providers
  DEFAULT_AI_PROVIDER: z.string().default('openai'),
  FALLBACK_AI_PROVIDER: z.string().default('anthropic'),
  LOCAL_MODEL_PROVIDER: z.string().default('ollama'),
  ENABLE_MULTI_PROVIDER_ROUTING: boolEnv(true),

  // Registry Sources
  ENABLE_GITHUB_REGISTRY: boolEnv(true),
  ENABLE_OFFICIAL_MCP_REGISTRY: boolEnv(true),
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

  // Approval Gates
  APPROVAL_WEBHOOK_URL: z.string().url().optional(),

  // Webhook / Events Adapter
  WEBHOOK_SECRET: z.string().optional(),
  EVENT_DEDUP_WINDOW_MS: intEnv(300_000, 0),

  // Cost Monitoring
  COST_TRACKING_ENABLED: boolEnv(true),
  COST_BUDGET_DAILY_USD: floatEnv(0, 0),

  // Runtime / Provisioning
  CACHE_TTL: intEnv(300, 0),
  MAX_CONCURRENT_INSTALLS: intEnv(5, 1, 100),
  ENABLE_AUTO_UPDATES: boolEnv(false),
  ENABLE_RUNTIME_HEALTH_RECOVERY: boolEnv(true),

  // Redis (future distributed caching)
  REDIS_URL: z.string().url().optional(),

  // Observability
  ENABLE_METRICS: boolEnv(true),
  ENABLE_TRACING: boolEnv(true),
  ENABLE_AUDIT_LOGGING: boolEnv(true),
});

export type Config = z.infer<typeof ConfigSchema>;

const INSECURE_DEFAULT = 'change-me-in-production-must-be-32chars!!';

let _config: Config | null = null;

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  _config = result.data;

  if (_config.NODE_ENV === 'production') {
    if (_config.JWT_SECRET === INSECURE_DEFAULT) {
      throw new Error('JWT_SECRET must be set to a strong, unique value in production');
    }
    if (_config.ENCRYPTION_KEY === INSECURE_DEFAULT) {
      throw new Error('ENCRYPTION_KEY must be set to a strong, unique value in production');
    }
    // Block silly log level in production
    if (_config.LOG_LEVEL === 'silly') {
      throw new Error('LOG_LEVEL=silly is not permitted in NODE_ENV=production');
    }
  }

  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    _config = validateConfig();
  }
  return _config;
}

/** Lazy proxy — reads from validated config on first access. */
export const config = new Proxy({} as Config, {
  get(_target, prop) {
    return getConfig()[prop as keyof Config];
  },
});

/** Reset config (for testing only). */
export function _resetConfig(): void {
  _config = null;
}
