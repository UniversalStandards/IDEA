/**
 * tests/config.test.ts
 * Unit tests for src/config.ts — Zod-validated configuration.
 */

import path from 'path';
import {
  validateConfig,
  _resetConfig,
  getAutoApprovedTools,
  getEphemeralSecretNames,
  isStdioOnly,
  resolveHubDataDir,
} from '../src/config';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-that-is-32-characters-long!!',
      ENCRYPTION_KEY: 'test-encryption-key-32-characters!!',
    };
    _resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetConfig();
  });

  it('parses valid config with default values', () => {
    const cfg = validateConfig();
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('test');
    expect(cfg.MCP_TRANSPORT).toBe('http');
    expect(cfg.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(cfg.RATE_LIMIT_MAX_REQUESTS).toBe(300);
    expect(cfg.COST_TRACKING_ENABLED).toBe(true);
    expect(cfg.COST_BUDGET_DAILY_USD).toBe(0);
  });

  it('parses PORT from environment', () => {
    process.env['PORT'] = '4000';
    const cfg = validateConfig();
    expect(cfg.PORT).toBe(4000);
  });

  it('throws when PORT is below minimum (1)', () => {
    process.env['PORT'] = '0';
    expect(() => validateConfig()).toThrow('Configuration validation failed');
  });

  it('throws when PORT is above maximum (65535)', () => {
    process.env['PORT'] = '99999';
    expect(() => validateConfig()).toThrow('Configuration validation failed');
  });

  it('transforms boolean env var \'false\' to false', () => {
    process.env['ENABLE_GITHUB_REGISTRY'] = 'false';
    const cfg = validateConfig();
    expect(cfg.ENABLE_GITHUB_REGISTRY).toBe(false);
  });

  it('transforms boolean env var \'0\' to false', () => {
    process.env['ENABLE_METRICS'] = '0';
    const cfg = validateConfig();
    expect(cfg.ENABLE_METRICS).toBe(false);
  });

  it('transforms boolean env var \'true\' to true', () => {
    process.env['ENABLE_TRACING'] = 'true';
    const cfg = validateConfig();
    expect(cfg.ENABLE_TRACING).toBe(true);
  });

  it('accepts wildcard CORS_ORIGIN', () => {
    process.env['CORS_ORIGIN'] = '*';
    const cfg = validateConfig();
    expect(cfg.CORS_ORIGIN).toBe('*');
  });

  it('accepts valid URL list for CORS_ORIGIN', () => {
    process.env['CORS_ORIGIN'] = 'https://app.example.com,https://admin.example.com';
    const cfg = validateConfig();
    expect(cfg.CORS_ORIGIN).toBe('https://app.example.com,https://admin.example.com');
  });

  it('rejects invalid URL in CORS_ORIGIN', () => {
    process.env['CORS_ORIGIN'] = 'not-a-url';
    expect(() => validateConfig()).toThrow('Configuration validation failed');
  });

  it('throws for insecure JWT_SECRET in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['JWT_SECRET'] = 'change-me-in-production-must-be-32chars!!';
    process.env['ENCRYPTION_KEY'] = 'valid-production-encryption-key-here!';
    expect(() => validateConfig()).toThrow('JWT_SECRET must be set');
  });

  it('throws for insecure ENCRYPTION_KEY in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['JWT_SECRET'] = 'valid-production-jwt-secret-32-chars!!';
    process.env['ENCRYPTION_KEY'] = 'change-me-in-production-must-be-32chars!!';
    expect(() => validateConfig()).toThrow('ENCRYPTION_KEY must be set');
  });

  describe('UpCloud worker factory — production transport security', () => {
    function productionEnv(overrides: Record<string, string> = {}): void {
      process.env['NODE_ENV'] = 'production';
      process.env['JWT_SECRET'] = 'valid-production-jwt-secret-32-chars!!';
      process.env['ENCRYPTION_KEY'] = 'valid-production-encryption-key-here!';
      process.env['ENABLE_UPCLOUD_WORKER_FACTORY'] = 'true';
      process.env['UPCLOUD_BROKER_URL'] = 'https://broker.example.com';
      process.env['VAULT_ADDR'] = 'https://vault.example.com';
      process.env['VAULT_ROLE_ID'] = 'role-123';
      process.env['VAULT_SECRET_ID'] = 'secret-123';
      process.env['MCP_AUTH_TOKEN'] = 'production-mcp-bearer-token-at-least-32-chars';
      Object.assign(process.env, overrides);
    }

    it('rejects an http:// UPCLOUD_BROKER_URL in production (carries the broker API key)', () => {
      productionEnv({ UPCLOUD_BROKER_URL: 'http://broker.example.com' });
      expect(() => validateConfig()).toThrow('UPCLOUD_BROKER_URL must use https://');
    });

    it('rejects an http:// VAULT_ADDR in production (carries Vault auth tokens and leased secrets)', () => {
      productionEnv({ VAULT_ADDR: 'http://vault.example.com' });
      expect(() => validateConfig()).toThrow('VAULT_ADDR must use https://');
    });

    it('accepts https:// UPCLOUD_BROKER_URL and VAULT_ADDR in production', () => {
      productionEnv();
      expect(() => validateConfig()).not.toThrow();
    });

    it('does not require https:// when ENABLE_UPCLOUD_WORKER_FACTORY is false', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['JWT_SECRET'] = 'valid-production-jwt-secret-32-chars!!';
      process.env['ENCRYPTION_KEY'] = 'valid-production-encryption-key-here!';
      process.env['ENABLE_UPCLOUD_WORKER_FACTORY'] = 'false';
      process.env['MCP_AUTH_TOKEN'] = 'production-mcp-bearer-token-at-least-32-chars';
      expect(() => validateConfig()).not.toThrow();
    });
  });

  describe('MCP endpoint security in production', () => {
    function production(overrides: Record<string, string> = {}): void {
      process.env['NODE_ENV'] = 'production';
      process.env['JWT_SECRET'] = 'valid-production-jwt-secret-32-chars!!';
      process.env['ENCRYPTION_KEY'] = 'valid-production-encryption-key-here!';
      Object.assign(process.env, overrides);
    }

    it('requires MCP_AUTH_TOKEN when the MCP HTTP endpoint is enabled', () => {
      production();
      expect(() => validateConfig()).toThrow('MCP_AUTH_TOKEN (min 32 chars) is required in production');
    });

    it('accepts an explicit MCP_ALLOW_UNAUTHENTICATED=true opt-out', () => {
      production({ MCP_ALLOW_UNAUTHENTICATED: 'true' });
      expect(() => validateConfig()).not.toThrow();
    });

    it('does not require a token when the MCP HTTP endpoint is disabled', () => {
      production({ MCP_HTTP_ENABLED: 'false' });
      expect(() => validateConfig()).not.toThrow();
    });

    it('rejects an MCP_AUTH_TOKEN shorter than 32 characters', () => {
      production({ MCP_AUTH_TOKEN: 'too-short' });
      expect(() => validateConfig()).toThrow('Configuration validation failed');
    });

    it('rejects an MCP_HTTP_PATH that is not an absolute path', () => {
      production({ MCP_AUTH_TOKEN: 'production-mcp-bearer-token-at-least-32-chars', MCP_HTTP_PATH: 'mcp' });
      expect(() => validateConfig()).toThrow('MCP_HTTP_PATH must be an absolute URL path');
    });
  });

  describe('stdio-only production mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
      process.env['MCP_TRANSPORT'] = 'stdio';
      delete process.env['JWT_SECRET'];
      delete process.env['ENCRYPTION_KEY'];
    });

    it('generates per-process secrets instead of failing on the insecure defaults', () => {
      const cfg = validateConfig();
      expect(cfg.JWT_SECRET).not.toBe('change-me-in-production-must-be-32chars!!');
      expect(cfg.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(cfg.ENCRYPTION_KEY).not.toBe(cfg.JWT_SECRET);
      expect(getEphemeralSecretNames()).toEqual(['JWT_SECRET', 'ENCRYPTION_KEY']);
    });

    it('keeps operator-supplied secrets', () => {
      process.env['JWT_SECRET'] = 'operator-supplied-jwt-secret-32-chars!!';
      const cfg = validateConfig();
      expect(cfg.JWT_SECRET).toBe('operator-supplied-jwt-secret-32-chars!!');
      expect(getEphemeralSecretNames()).toEqual(['ENCRYPTION_KEY']);
    });

    it('does not require MCP_AUTH_TOKEN (no network listener)', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('still fails on default secrets when STDIO_ENABLE_HTTP opens a listener', () => {
      process.env['STDIO_ENABLE_HTTP'] = 'true';
      expect(() => validateConfig()).toThrow('JWT_SECRET must be set');
    });

    it('reports no ephemeral secrets outside stdio-only mode', () => {
      process.env['NODE_ENV'] = 'test';
      process.env['MCP_TRANSPORT'] = 'http';
      validateConfig();
      expect(getEphemeralSecretNames()).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('treats empty-string variables as unset', () => {
      process.env['REDIS_URL'] = '';
      process.env['ENTERPRISE_CATALOG_URL'] = '';
      process.env['MCP_HTTP_PATH'] = '';
      const cfg = validateConfig();
      expect(cfg.REDIS_URL).toBeUndefined();
      expect(cfg.MCP_HTTP_PATH).toBe('/mcp');
    });

    it('identifies stdio-only mode', () => {
      expect(isStdioOnly({ MCP_TRANSPORT: 'stdio', STDIO_ENABLE_HTTP: false })).toBe(true);
      expect(isStdioOnly({ MCP_TRANSPORT: 'stdio', STDIO_ENABLE_HTTP: true })).toBe(false);
      expect(isStdioOnly({ MCP_TRANSPORT: 'http', STDIO_ENABLE_HTTP: false })).toBe(false);
    });

    it('parses AUTO_APPROVE_TOOLS into a trimmed set', () => {
      expect([...getAutoApprovedTools({ AUTO_APPROVE_TOOLS: ' official:memory, ,official:time ' })]).toEqual([
        'official:memory',
        'official:time',
      ]);
      expect(getAutoApprovedTools({ AUTO_APPROVE_TOOLS: '' }).size).toBe(0);
    });

    it('resolves the hub data directory', () => {
      expect(resolveHubDataDir({ HUB_DATA_DIR: '/srv/hub' })).toBe(path.resolve('/srv/hub'));
      expect(resolveHubDataDir({ HUB_DATA_DIR: undefined })).toBe(path.join(process.cwd(), '.mcp'));
    });
  });

  it('accepts every supported MCP_TRANSPORT value', () => {
    for (const transport of ['http', 'http2', 'stdio', 'sse', 'websocket', 'grpc'] as const) {
      process.env['MCP_TRANSPORT'] = transport;
      _resetConfig();
      const cfg = validateConfig();
      expect(cfg.MCP_TRANSPORT).toBe(transport);
    }
  });

  it('rejects invalid MCP_TRANSPORT value', () => {
    process.env['MCP_TRANSPORT'] = 'carrier-pigeon';
    expect(() => validateConfig()).toThrow('Configuration validation failed');
  });

  it('parses RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS', () => {
    process.env['RATE_LIMIT_WINDOW_MS'] = '120000';
    process.env['RATE_LIMIT_MAX_REQUESTS'] = '100';
    const cfg = validateConfig();
    expect(cfg.RATE_LIMIT_WINDOW_MS).toBe(120_000);
    expect(cfg.RATE_LIMIT_MAX_REQUESTS).toBe(100);
  });

  it('parses COST_BUDGET_DAILY_USD as float', () => {
    process.env['COST_BUDGET_DAILY_USD'] = '9.99';
    const cfg = validateConfig();
    expect(cfg.COST_BUDGET_DAILY_USD).toBeCloseTo(9.99);
  });
});
