/**
 * tests/config.test.ts
 * Unit tests for src/config.ts — Zod-validated configuration.
 */

import { validateConfig, _resetConfig } from '../src/config';

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

  it('accepts MCP_TRANSPORT values: http, stdio, sse', () => {
    for (const transport of ['http', 'stdio', 'sse'] as const) {
      process.env['MCP_TRANSPORT'] = transport;
      _resetConfig();
      const cfg = validateConfig();
      expect(cfg.MCP_TRANSPORT).toBe(transport);
    }
  });

  it('rejects invalid MCP_TRANSPORT value', () => {
    process.env['MCP_TRANSPORT'] = 'websocket';
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
