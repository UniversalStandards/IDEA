/**
 * tests/openapi.test.ts
 * Unit tests for src/api/openapi.ts
 * Validates spec generation and route behaviour without making real HTTP calls.
 */

process.env['NODE_ENV'] = 'test';
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { generateSpec, _resetSpecCache, openapiRouter } from '../src/api/openapi';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: pkgVersion } = require('../package.json') as { version: string };

describe('generateSpec()', () => {
  beforeEach(() => {
    _resetSpecCache();
  });

  it('generates a valid OpenAPI 3.1 document', () => {
    const spec = generateSpec('http://localhost:3000');
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain('Admin API');
    expect(spec.paths).toBeDefined();
  });

  it('includes all admin paths', () => {
    const spec = generateSpec('http://localhost:3000');
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain('/admin/capabilities');
    expect(paths).toContain('/admin/capabilities/{id}');
    expect(paths).toContain('/admin/policies');
    expect(paths).toContain('/admin/costs');
    expect(paths).toContain('/admin/audit');
  });

  it('includes health paths', () => {
    const spec = generateSpec('http://localhost:3000');
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain('/health');
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
  });

  it('registers BearerAuth security scheme', () => {
    const spec = generateSpec('http://localhost:3000');
    expect(spec.components?.securitySchemes?.['BearerAuth']).toBeDefined();
    const bearerScheme = spec.components?.securitySchemes?.['BearerAuth'] as unknown as Record<string, unknown>;
    expect(bearerScheme['type']).toBe('http');
    expect(bearerScheme['scheme']).toBe('bearer');
    expect(bearerScheme['bearerFormat']).toBe('JWT');
  });

  it('marks admin routes as requiring BearerAuth', () => {
    const spec = generateSpec('http://localhost:3000');
    const adminCapabilitiesGet = spec.paths?.['/admin/capabilities']?.['get'] as
      | { security?: Array<Record<string, unknown[]>> }
      | undefined;
    expect(adminCapabilitiesGet?.security).toBeDefined();
    const securityEntry = adminCapabilitiesGet?.security?.[0];
    expect(securityEntry).toHaveProperty('BearerAuth');
  });

  it('sets server URL from parameter', () => {
    const spec = generateSpec('https://api.example.com');
    expect(spec.servers).toBeDefined();
    expect(spec.servers?.[0]?.url).toBe('https://api.example.com');
  });

  it('returns the same cached instance on repeated calls', () => {
    const spec1 = generateSpec('http://localhost:3000');
    const spec2 = generateSpec('http://localhost:3000');
    expect(spec1).toBe(spec2);
  });

  it('returns fresh spec after _resetSpecCache()', () => {
    const spec1 = generateSpec('http://localhost:3000');
    _resetSpecCache();
    const spec2 = generateSpec('http://localhost:3000');
    expect(spec1).not.toBe(spec2);
  });

  it('includes the package version in info.version', () => {
    const spec = generateSpec('http://localhost:3000');
    expect(spec.info.version).toBe(pkgVersion);
  });

  it('includes Apache-2.0 license in info', () => {
    const spec = generateSpec('http://localhost:3000');
    expect(spec.info.license?.name).toBe('Apache-2.0');
  });

  it('DELETE /admin/capabilities/{id} documents 404 response', () => {
    const spec = generateSpec('http://localhost:3000');
    const deletePath = spec.paths?.['/admin/capabilities/{id}']?.['delete'] as
      | { responses: Record<string, unknown> }
      | undefined;
    expect(deletePath?.responses?.['404']).toBeDefined();
  });

  it('GET /admin/costs documents query parameters', () => {
    const spec = generateSpec('http://localhost:3000');
    const costPath = spec.paths?.['/admin/costs']?.['get'] as
      | { parameters?: Array<{ name: string }> }
      | undefined;
    const params = costPath?.parameters ?? [];
    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain('windowHours');
  });

  it('GET /admin/audit documents limit and offset query parameters', () => {
    const spec = generateSpec('http://localhost:3000');
    const auditPath = spec.paths?.['/admin/audit']?.['get'] as
      | { parameters?: Array<{ name: string }> }
      | undefined;
    const params = auditPath?.parameters ?? [];
    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain('limit');
    expect(paramNames).toContain('offset');
  });
});

describe('openapiRouter', () => {
  it('is an Express router function', () => {
    expect(typeof openapiRouter).toBe('function');
    expect(openapiRouter.stack).toBeDefined();
  });

  it('has at least 2 route layers (openapi.json + docs)', () => {
    expect(openapiRouter.stack.length).toBeGreaterThanOrEqual(2);
  });
});
