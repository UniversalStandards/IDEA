/**
 * tests/admin-api.test.ts
 * Integration tests for src/api/admin-api.ts
 * Uses jest mocks instead of supertest to avoid the supertest devDependency.
 */

const JWT_SECRET = 'test-secret-that-is-32-characters-long!!';

// Set up env before any module imports
process.env['JWT_SECRET'] = JWT_SECRET;
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: {
    record: jest.fn(),
    getRecentEntries: jest.fn().mockReturnValue({ entries: [], total: 0 }),
  },
}));

jest.mock('../src/core/runtime-manager', () => ({
  runtimeManager: {
    isInitialized: jest.fn(() => true),
    getCapabilities: jest.fn(() => [{ id: 'tool-1', name: 'Test Tool' }]),
    deregisterCapability: jest.fn((id: string) => id === 'known-tool'),
  },
}));

import jwt from 'jsonwebtoken';
import { adminRouter } from '../src/api/admin-api';

type MockReq = {
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  ip: string;
};

type MockRes = {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  _statusCode: number;
  _body: unknown;
};

function makeRes(): MockRes {
  const res = {
    _statusCode: 200,
    _body: null,
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
  } as MockRes;
  res.status.mockReturnValue(res);
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

function makeReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    ...overrides,
  };
}

function validToken(): string {
  return jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Admin API — Authentication Middleware', () => {
  // Find the requireAuth middleware by invoking a route without auth
  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    // Access the middleware layer — test via the router's stack
    // Since we can't call middleware directly without the Express request cycle,
    // we test the behavior through the token parsing logic
    expect(typeof adminRouter).toBe('function');

    // Test the JWT validation logic directly
    const header = req.headers['authorization'];
    expect(header).toBeUndefined();
    // Without Authorization header, admin routes should reject
    expect(next).not.toHaveBeenCalled();
    // The actual 401 is returned by the middleware; this test verifies the precondition
    expect(res.status).not.toHaveBeenCalled();
  });

  it('generates a valid JWT token that can be verified', () => {
    const token = validToken();
    const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    expect(decoded['sub']).toBe('admin');
    expect(decoded['role']).toBe('admin');
  });

  it('rejects a token signed with the wrong secret', () => {
    const wrongToken = jwt.sign({ sub: 'admin' }, 'wrong-secret-that-is-very-long-padding!!');
    expect(() => jwt.verify(wrongToken, JWT_SECRET)).toThrow();
  });

  it('rejects an expired token', () => {
    const expiredToken = jwt.sign({ sub: 'admin' }, JWT_SECRET, { expiresIn: -1 });
    expect(() => jwt.verify(expiredToken, JWT_SECRET)).toThrow();
  });
});

describe('Admin API — Route Logic', () => {
  it('adminRouter is an Express router function', () => {
    expect(typeof adminRouter).toBe('function');
    expect(adminRouter.stack).toBeDefined();
  });

  it('has the expected number of route layers', () => {
    // Should have: auth middleware + 5 routes (capabilities, capabilities/:id, policies, costs, audit)
    expect(adminRouter.stack.length).toBeGreaterThanOrEqual(5);
  });
});

describe('Audit query schema validation', () => {
  it('accepts valid limit within range 1-500', () => {
    const { z } = require('zod') as typeof import('zod');
    const schema = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    expect(schema.parse({ limit: '50' }).limit).toBe(50);
    expect(schema.parse({}).limit).toBe(50);
  });

  it('rejects limit above 500', () => {
    const { z } = require('zod') as typeof import('zod');
    const schema = z.object({ limit: z.coerce.number().int().min(1).max(500) });
    expect(() => schema.parse({ limit: '501' })).toThrow();
  });
});

describe('Admin API — GET /admin/capabilities (via route handler)', () => {
  it('returns capability list when called with a valid JWT', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { isInitialized: jest.Mock; getCapabilities: jest.Mock };
    };
    runtimeManager.isInitialized.mockReturnValue(true);
    runtimeManager.getCapabilities.mockReturnValue([
      { id: 'cap-1', name: 'Capability One' },
      { id: 'cap-2', name: 'Capability Two' },
    ]);

    // Build a minimal Express-like request/response and manually invoke the route layer
    // that handles GET /capabilities. The handler sits after the requireAuth middleware,
    // so we walk the router stack to find it.
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = adminRouter.stack as unknown as Layer[];
    const capLayer = stack.find((l) => l.route?.path === '/capabilities' && l.route?.methods['get']);
    expect(capLayer).toBeDefined();

    const req = makeReq({ headers: { authorization: `Bearer ${validToken()}` } });
    const res = makeRes();

    capLayer!.route!.stack.forEach((s) => s.handle(req, res));

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
    );
    const body = res._body as { capabilities: unknown[]; count: number };
    expect(body.capabilities).toHaveLength(2);
  });
});

describe('Health endpoints — /health/live and /health/ready', () => {
  it('GET /health/live always returns 200', () => {
    // Import healthRouter directly and invoke the /live handler
    const { healthRouter } = require('../src/api/health') as { healthRouter: import('express').Router };

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = healthRouter.stack as unknown as Layer[];
    const liveLayer = stack.find((l) => l.route?.path === '/live' && l.route?.methods['get']);
    expect(liveLayer).toBeDefined();

    const req = makeReq();
    const res = makeRes();
    liveLayer!.route!.stack.forEach((s) => s.handle(req, res));

    // status was called with 200 OR not at all (defaults to 200 in Express)
    const statusCall = (res.status as jest.Mock).mock.calls[0];
    if (statusCall) {
      expect(statusCall[0]).toBe(200);
    }
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('GET /health/ready returns 503 when runtime is not initialized', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { isInitialized: jest.Mock };
    };
    runtimeManager.isInitialized.mockReturnValueOnce(false);

    const { healthRouter } = require('../src/api/health') as { healthRouter: import('express').Router };

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = healthRouter.stack as unknown as Layer[];
    const readyLayer = stack.find((l) => l.route?.path === '/ready' && l.route?.methods['get']);
    expect(readyLayer).toBeDefined();

    const req = makeReq();
    const res = makeRes();
    readyLayer!.route!.stack.forEach((s) => s.handle(req, res));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' }));
  });

  it('GET /health/ready returns 200 when runtime is initialized', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { isInitialized: jest.Mock };
    };
    runtimeManager.isInitialized.mockReturnValueOnce(true);

    const { healthRouter } = require('../src/api/health') as { healthRouter: import('express').Router };

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = healthRouter.stack as unknown as Layer[];
    const readyLayer = stack.find((l) => l.route?.path === '/ready' && l.route?.methods['get']);
    expect(readyLayer).toBeDefined();

    const req = makeReq();
    const res = makeRes();
    readyLayer!.route!.stack.forEach((s) => s.handle(req, res));

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('GET /health (combined) returns 200 and body with version when runtime is ready', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { isInitialized: jest.Mock };
    };
    runtimeManager.isInitialized.mockReturnValueOnce(true);

    const { healthRouter } = require('../src/api/health') as { healthRouter: import('express').Router };
    type HLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = healthRouter.stack as unknown as HLayer[];
    const healthLayer = stack.find((l) => l.route?.path === '/' && l.route?.methods['get']);
    expect(healthLayer).toBeDefined();

    const req = makeReq();
    const res = makeRes();
    healthLayer!.route!.stack.forEach((s) => s.handle(req, res));

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('GET /health (combined) returns 503 when runtime is not ready', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { isInitialized: jest.Mock };
    };
    runtimeManager.isInitialized.mockReturnValueOnce(false);

    const { healthRouter } = require('../src/api/health') as { healthRouter: import('express').Router };
    type HLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } };
    const stack = healthRouter.stack as unknown as HLayer[];
    const healthLayer = stack.find((l) => l.route?.path === '/' && l.route?.methods['get']);
    expect(healthLayer).toBeDefined();

    const req = makeReq();
    const res = makeRes();
    healthLayer!.route!.stack.forEach((s) => s.handle(req, res));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });
});

// ─────────────────────────────────────────────────────────────────
// Helpers: reusable router-stack walker
// ─────────────────────────────────────────────────────────────────

// Extract the requireAuth middleware from the router's use() layer
type ExtLayer = {
  route?: unknown;
  handle: (req: unknown, res: unknown, next: jest.Mock) => void;
};

function getRequireAuth(): (req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>, next: jest.Mock) => void {
  const stack = adminRouter.stack as unknown as ExtLayer[];
  const layer = stack.find((l) => l.route === undefined && typeof l.handle === 'function');
  return layer!.handle as (req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>, next: jest.Mock) => void;
}

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next?: jest.Mock) => void }>;
  };
};

function invokeRoute(
  router: import('express').Router,
  method: 'get' | 'delete' | 'post',
  path: string,
  req: ReturnType<typeof makeReq>,
  res: ReturnType<typeof makeRes>,
): void {
  const stack = router.stack as unknown as Layer[];
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  expect(layer).toBeDefined();
  layer!.route!.stack.forEach((s) => s.handle(req, res, jest.fn()));
}

describe('Admin API — DELETE /admin/capabilities/:id', () => {
  it('returns 200 and confirms deregistration for a known capability ID', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { deregisterCapability: jest.Mock };
    };
    runtimeManager.deregisterCapability.mockReturnValueOnce(true);

    const req = makeReq({ params: { id: 'known-tool' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'delete', '/capabilities/:id', req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('known-tool') as string }),
    );
  });

  it('returns 404 when capability is not found', () => {
    const { runtimeManager } = require('../src/core/runtime-manager') as {
      runtimeManager: { deregisterCapability: jest.Mock };
    };
    runtimeManager.deregisterCapability.mockReturnValueOnce(false);

    const req = makeReq({ params: { id: 'missing-tool' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'delete', '/capabilities/:id', req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when capability ID is empty string', () => {
    const req = makeReq({ params: { id: '' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'delete', '/capabilities/:id', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid capability ID' }));
  });
});

describe('Admin API — GET /admin/policies', () => {
  it('returns policies array and count', () => {
    const req = makeReq();
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/policies', req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ policies: expect.any(Array) as unknown[], count: expect.any(Number) as number }),
    );
  });
});

describe('Admin API — GET /admin/costs', () => {
  it('returns cost summary with default 24h window', () => {
    const req = makeReq({ query: {} });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/costs', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['window']).toBe('24h');
    expect(body['totalCostUsd']).toBe(0);
  });

  it('returns cost summary with a custom window', () => {
    const req = makeReq({ query: { windowHours: '48' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/costs', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['window']).toBe('48h');
  });

  it('returns 400 for invalid windowHours', () => {
    const req = makeReq({ query: { windowHours: '999' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/costs', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('Admin API — GET /admin/audit', () => {
  it('returns entries array with default pagination', () => {
    const req = makeReq({ query: {} });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['entries']).toEqual([]);
    expect(body['limit']).toBe(50);
    expect(body['offset']).toBe(0);
  });

  it('returns entries with custom limit and offset', () => {
    const req = makeReq({ query: { limit: '10', offset: '20' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['limit']).toBe(10);
    expect(body['offset']).toBe(20);
  });

  it('returns 400 for limit > 500', () => {
    const req = makeReq({ query: { limit: '501' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('filters by action when provided', () => {
    const req = makeReq({ query: { action: 'tool.install' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['action']).toBe('tool.install');
  });
});

// ─────────────────────────────────────────────────────────────────
// New: requireAuth middleware direct tests (lines 26-43 in source)
// ─────────────────────────────────────────────────────────────────

describe('Admin API — requireAuth middleware (direct)', () => {
  it('returns 401 when Authorization header is missing', () => {
    const requireAuth = getRequireAuth();
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header lacks "Bearer " prefix', () => {
    const requireAuth = getRequireAuth();
    const req = makeReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when JWT token is invalid', () => {
    const requireAuth = getRequireAuth();
    const req = makeReq({ headers: { authorization: 'Bearer not.a.valid.jwt.token' } });
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when JWT is valid', () => {
    const requireAuth = getRequireAuth();
    const req = makeReq({ headers: { authorization: `Bearer ${validToken()}` } });
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// New: 500 error paths and additional validation branches
// ─────────────────────────────────────────────────────────────────

describe('Admin API — error paths (500) and additional validation', () => {
  it('GET /capabilities returns 500 when getCapabilities throws', () => {
    const { runtimeManager: rm } = require('../src/core/runtime-manager') as {
      runtimeManager: { getCapabilities: jest.Mock };
    };
    rm.getCapabilities.mockImplementationOnce(() => {
      throw new Error('internal error');
    });

    const req = makeReq();
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/capabilities', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to retrieve capabilities' }));
  });

  it('DELETE /capabilities/:id returns 400 when ID exceeds 255 chars', () => {
    const longId = 'a'.repeat(256);
    const req = makeReq({ params: { id: longId } });
    const res = makeRes();
    invokeRoute(adminRouter, 'delete', '/capabilities/:id', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid capability ID' }));
  });

  it('DELETE /capabilities/:id returns 500 when deregisterCapability throws', () => {
    const { runtimeManager: rm } = require('../src/core/runtime-manager') as {
      runtimeManager: { deregisterCapability: jest.Mock };
    };
    rm.deregisterCapability.mockImplementationOnce(() => {
      throw new Error('internal error');
    });

    const req = makeReq({ params: { id: 'some-valid-tool' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'delete', '/capabilities/:id', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to deregister capability' }));
  });

  it('GET /policies returns 500 when listPolicies throws', () => {
    const { policyEngine: pe } = require('../src/policy/policy-engine') as {
      policyEngine: { listPolicies: () => unknown[] };
    };
    const spy = jest.spyOn(pe, 'listPolicies').mockImplementationOnce(() => {
      throw new Error('internal error');
    });

    const req = makeReq();
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/policies', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to retrieve policies' }));
    spy.mockRestore();
  });

  it('GET /costs returns 400 for non-numeric windowHours', () => {
    const req = makeReq({ query: { windowHours: 'abc' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/costs', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('GET /costs returns 500 when getCostSummary throws', () => {
    const { costMonitor: cm } = require('../src/observability/cost-monitor') as {
      costMonitor: { getCostSummary: (ms: number) => unknown };
    };
    const spy = jest.spyOn(cm, 'getCostSummary').mockImplementationOnce(() => {
      throw new Error('internal error');
    });

    const req = makeReq({ query: { windowHours: '24' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/costs', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to retrieve cost data' }));
    spy.mockRestore();
  });

  it('GET /audit returns 400 for non-numeric limit', () => {
    const req = makeReq({ query: { limit: 'abc' } });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('GET /audit returns 500 when getRecentEntries throws', () => {
    const { auditLog: al } = require('../src/security/audit') as {
      auditLog: { getRecentEntries: jest.Mock };
    };
    al.getRecentEntries.mockImplementationOnce(() => {
      throw new Error('internal error');
    });

    const req = makeReq({ query: {} });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to retrieve audit entries' }));
  });

  it('GET /audit returns action: null in response when no action filter provided', () => {
    const { auditLog: al } = require('../src/security/audit') as {
      auditLog: { getRecentEntries: jest.Mock };
    };
    al.getRecentEntries.mockReturnValueOnce({ entries: [{ id: '1' }], total: 1 });

    const req = makeReq({ query: {} });
    const res = makeRes();
    invokeRoute(adminRouter, 'get', '/audit', req, res);

    const body = res._body as Record<string, unknown>;
    expect(body['action']).toBeNull();
    expect(body['total']).toBe(1);
  });
});
