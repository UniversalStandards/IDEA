/**
 * tests/tenant-middleware.test.ts
 * Unit tests for src/multitenancy/TenantMiddleware.ts.
 *
 * Added alongside the PR #173 review-response fix that gives worker-session
 * bearer tokens (src/adapters/upcloud-worker-factory/index.ts) a signing key
 * derived from, but never equal to, JWT_SECRET. Before that change, this
 * middleware's `jwt.verify(token, getConfig().JWT_SECRET)` would happily
 * verify a worker-session token too — it only "worked" because worker
 * tokens happened not to carry an `orgId`/`org_id` claim, not because of
 * any real check. These tests pin down that a worker-session token is
 * rejected outright here now, on signature mismatch, regardless of what
 * claims it carries.
 */

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { createTenantMiddleware } from '../src/multitenancy/TenantMiddleware';
import { deriveWorkerSessionKey } from '../src/adapters/upcloud-worker-factory/index';
import { _resetConfig } from '../src/config';
import type { TenantStore } from '../src/multitenancy/TenantStore';
import type { Tenant } from '../src/multitenancy/schemas/tenant.schema';

const JWT_SECRET = 'test-secret-that-is-32-characters-long!!';

function fakeStore(activeOrgIds: string[]): TenantStore {
  const tenants = new Map<string, Tenant>(
    activeOrgIds.map((orgId) => [
      orgId,
      {
        orgId,
        name: orgId,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
        workspaces: [],
      } as Tenant,
    ]),
  );
  return {
    get: (orgId: string) => tenants.get(orgId),
    resolveOrgIdByApiKey: () => undefined,
  } as unknown as TenantStore;
}

type MockRes = { status: jest.Mock; json: jest.Mock };

function makeReqResNext(authorization?: string): {
  req: Request;
  res: MockRes;
  next: NextFunction;
} {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  const res: MockRes = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next: next as NextFunction };
}

describe('TenantMiddleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      JWT_SECRET,
      ENCRYPTION_KEY: 'test-encryption-key-32-characters!!',
    };
    _resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetConfig();
  });

  it('resolves an active tenant from an ordinary org-scoped JWT', () => {
    const middleware = createTenantMiddleware(fakeStore(['org-1']));
    const token = jwt.sign({ orgId: 'org-1' }, JWT_SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqResNext(`Bearer ${token}`);

    middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.orgId).toBe('org-1');
  });

  it('rejects a genuine worker-session token outright, even if it somehow carried an orgId claim', () => {
    // Signed with deriveWorkerSessionKey(JWT_SECRET), exactly as the
    // adapter mints it — not with JWT_SECRET directly. Carries an orgId
    // claim it should never legitimately have, to prove the rejection is
    // key separation, not an accident of the token's shape.
    const middleware = createTenantMiddleware(fakeStore(['org-1']));
    const workerToken = jwt.sign(
      { sub: 'agent-1', scope: 'worker-session', sessionId: 'sess-abc', orgId: 'org-1' },
      deriveWorkerSessionKey(JWT_SECRET),
      { expiresIn: '15m' },
    );
    const { req, res, next } = makeReqResNext(`Bearer ${workerToken}`);

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when no bearer token or API key is presented', () => {
    const middleware = createTenantMiddleware(fakeStore(['org-1']));
    const { req, res, next } = makeReqResNext();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
