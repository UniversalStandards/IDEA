import jwt from 'jsonwebtoken';
import { readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTenantMiddleware } from '../src/multitenancy/TenantMiddleware';
import { NamespaceIsolator, InMemoryKeyValueStore } from '../src/multitenancy/NamespaceIsolator';
import { TenantManager } from '../src/multitenancy/TenantManager';
import { TenantProvisioner } from '../src/multitenancy/TenantProvisioner';
import { TenantStore } from '../src/multitenancy/TenantStore';
import { _resetConfig } from '../src/config';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

let testCounter = 0;

function makeMockResponse(): {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  json: jest.Mock;
} {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status: jest.fn(),
    json: jest.fn(),
  };

  response.status.mockImplementation((code: number) => {
    response.statusCode = code;
    return response;
  });

  response.json.mockImplementation((payload: unknown) => {
    response.body = payload;
    return response;
  });

  return response;
}

describe('Multitenancy integration', () => {
  let tenantStore: TenantStore;
  let tenantManager: TenantManager;
  let namespaceIsolator: NamespaceIsolator;
  let provisioner: TenantProvisioner;
  let policyDir: string;

  beforeEach(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
    process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
    _resetConfig();

    testCounter += 1;

    const storePath = path.join(os.tmpdir(), `idea-tenant-store-${testCounter}.json`);
    const configDir = path.join(os.tmpdir(), `idea-config-${testCounter}`);
    policyDir = path.join(os.tmpdir(), `idea-policies-${testCounter}`);

    await rm(storePath, { force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(policyDir, { recursive: true, force: true });

    tenantStore = new TenantStore(storePath);
    tenantManager = new TenantManager(tenantStore);
    await tenantManager.initialize();

    namespaceIsolator = new NamespaceIsolator(new InMemoryKeyValueStore(), new InMemoryKeyValueStore(), configDir);
    provisioner = new TenantProvisioner(tenantManager, namespaceIsolator, policyDir);

    await provisioner.provision({ orgId: 'org-a', name: 'Org A', ownerUserId: 'user-a', apiKey: 'api-key-a' });
    await provisioner.provision({ orgId: 'org-b', name: 'Org B', ownerUserId: 'user-b', apiKey: 'api-key-b' });
  });

  it('prevents cross-tenant data access between org A and org B', () => {
    namespaceIsolator.setDb('org-a', 'capabilities', [{ id: 'cap-a' }]);
    namespaceIsolator.setDb('org-b', 'capabilities', [{ id: 'cap-b' }]);

    expect(namespaceIsolator.getDb('org-a', 'capabilities')).toEqual([{ id: 'cap-a' }]);
    expect(namespaceIsolator.getDb('org-b', 'capabilities')).toEqual([{ id: 'cap-b' }]);
    expect(namespaceIsolator.getDb('org-a', 'capabilities')).not.toEqual(namespaceIsolator.getDb('org-b', 'capabilities'));

    expect(() => namespaceIsolator.getDb('org-a', 'tenant:org-b:capabilities')).toThrow(
      'Resource must not contain tenant/cache namespace prefixes',
    );
  });

  it('extracts orgId from JWT and injects request context', () => {
    namespaceIsolator.setDb('org-a', 'audit_log', [{ event: 'a-only' }]);

    const middleware = createTenantMiddleware(tenantStore);
    const token = jwt.sign({ sub: 'user-a', orgId: 'org-a' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' });

    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Parameters<ReturnType<typeof createTenantMiddleware>>[0];
    const res = makeMockResponse();
    const next = jest.fn();

    middleware(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.orgId).toBe('org-a');
    expect(req.tenantContext).toEqual({ orgId: 'org-a' });
    expect(namespaceIsolator.getDb(req.orgId ?? '', 'audit_log')).toEqual([{ event: 'a-only' }]);
    expect(() => namespaceIsolator.getDb(req.orgId ?? '', 'tenant:org-b:audit_log')).toThrow();
  });

  it('extracts orgId from API key and rejects requests without tenant context', () => {
    const middleware = createTenantMiddleware(tenantStore);

    const missingReq = { headers: {} } as unknown as Parameters<ReturnType<typeof createTenantMiddleware>>[0];
    const missingRes = makeMockResponse();
    const missingNext = jest.fn();
    middleware(missingReq, missingRes as never, missingNext);

    expect(missingNext).not.toHaveBeenCalled();
    expect(missingRes.statusCode).toBe(401);

    const apiKeyReq = { headers: { 'x-api-key': 'api-key-b' } } as unknown as Parameters<ReturnType<typeof createTenantMiddleware>>[0];
    const apiKeyRes = makeMockResponse();
    const apiKeyNext = jest.fn();
    middleware(apiKeyReq, apiKeyRes as never, apiKeyNext);

    expect(apiKeyNext).toHaveBeenCalledTimes(1);
    expect(apiKeyReq.orgId).toBe('org-b');
  });

  it('suspends tenant and terminates active sessions within 5 seconds', async () => {
    tenantManager.registerSession('org-a', 'session-1');
    tenantManager.registerSession('org-a', 'session-2');

    const start = Date.now();
    const suspended = await tenantManager.suspend('org-a');
    const durationMs = Date.now() - start;

    expect(suspended.status).toBe('suspended');
    expect(durationMs).toBeLessThan(5_000);
    expect(tenantManager.getSessionCount('org-a')).toBe(0);
  });

  it('provisions tenant defaults in under 2 seconds', async () => {
    const result = await provisioner.provision({
      orgId: 'org-c',
      name: 'Org C',
      ownerUserId: 'user-c',
      apiKey: 'api-key-c',
    });

    expect(result.durationMs).toBeLessThan(2_000);
    expect(result.initializedResources).toEqual(
      expect.arrayContaining([
        'tenant:org-c:capabilities',
        'tenant:org-c:audit_log',
        'tenant:org-c:roles',
        'tc:org-c:quota',
      ]),
    );

    const configContents = await namespaceIsolator.readTenantConfig('org-c');
    expect(configContents).toContain('orgId: org-c');

    const policyContents = await readFile(path.join(policyDir, 'org-c', 'policy.json'), 'utf8');
    expect(policyContents).toContain('tenant-default-manage');
  });
});
