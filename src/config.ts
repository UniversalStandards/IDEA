import * as dotenv from 'dotenv';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// Load .env file if present
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const boolEnv = (defaultVal: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultVal;
      return v.toLowerCase() !== 'false' && v !== '0';
    });

const ConfigSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 3000))
    .pipe(z.number().int().min(1).max(65535)),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),

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

  // GitHub Integration
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
  GITHUB_BRANCH: z.string().default('main'),

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

  // Runtime
  CACHE_TTL: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 300))
    .pipe(z.number().int().min(0)),
  MAX_CONCURRENT_INSTALLS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 5))
    .pipe(z.number().int().min(1).max(100)),
  ENABLE_AUTO_UPDATES: boolEnv(false),
  ENABLE_RUNTIME_HEALTH_RECOVERY: boolEnv(true),

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
  }

  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    _config = validateConfig();
  }
  return _config;
}

export const config = new Proxy({} as Config, {
  get(_target, prop) {
    return getConfig()[prop as keyof Config];
  },
});
