/**
 * tests/health.test.ts
 * Unit tests for src/api/health.ts.
 *
 * runtimeManager is mocked at the module level — these tests are about
 * whether GET /health and GET /health/ready surface what runtimeManager's
 * own getStatus()/isInitialized() report, not about runtimeManager's own
 * logic (covered elsewhere). This also sidesteps a pre-existing, unrelated
 * compile error in src/core/runtime-manager.ts's own transitive imports
 * (capability-selector.ts, request-normalizer.ts, cli/index.ts — see
 * CHANGELOG.md's "Known issue" entries): mocking the module here means
 * ts-jest never needs to type-check its real implementation.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockGetStatus = jest.fn();
const mockIsInitialized = jest.fn();

jest.mock('../src/core/runtime-manager', () => ({
  runtimeManager: {
    isInitialized: () => mockIsInitialized(),
    getStatus: () => mockGetStatus(),
  },
}));

import { healthRouter } from '../src/api/health';

type MockRes = {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  _body: unknown;
};

function makeRes(): MockRes {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    _body: null,
  } as MockRes;
  res.status.mockReturnValue(res);
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

/** Grabs a registered GET handler directly off the router's own stack,
 *  the same pattern tests/admin-api.test.ts uses, so these tests drive the
 *  real route handlers rather than re-deriving their logic. */
function routeHandle(path: string): (req: unknown, res: unknown) => void {
  const layer = (
    healthRouter as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } }>;
    }
  ).stack.find((l) => l.route?.path === path);
  if (!layer?.route) {
    throw new Error(`healthRouter has no registered route for '${path}'`);
  }
  return layer.route.stack[0]!.handle;
}

function healthyStatus(overrides: { workerFactoryHealthy?: boolean; workerFactoryDetail?: string } = {}) {
  return {
    healthy: overrides.workerFactoryHealthy ?? true,
    subsystems: [
      {
        name: 'upcloud-worker-factory',
        healthy: overrides.workerFactoryHealthy ?? true,
        detail: overrides.workerFactoryDetail ?? '0 active worker sessions',
      },
    ],
    installedTools: 0,
    runningTools: 0,
    schedulerStats: {},
    timestamp: new Date().toISOString(),
  };
}

describe('GET /health', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
    mockIsInitialized.mockReset();
  });

  it('reports ok, 200, and a healthy workerFactory check when the runtime is ready and no sessions are pending teardown', () => {
    mockIsInitialized.mockReturnValue(true);
    mockGetStatus.mockReturnValue(healthyStatus());
    const res = makeRes();

    routeHandle('/')({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res._body as { status: string; checks: { workerFactory: { status: string } } };
    expect(body.status).toBe('ok');
    expect(body.checks.workerFactory.status).toBe('ok');
  });

  it('surfaces a pending-teardown worker-factory fault as a degraded check, without failing the overall 200', () => {
    mockIsInitialized.mockReturnValue(true);
    mockGetStatus.mockReturnValue(
      healthyStatus({
        workerFactoryHealthy: false,
        workerFactoryDetail: '2 active worker sessions (1 pending broker-side teardown)',
      }),
    );
    const res = makeRes();

    routeHandle('/')({}, res);

    // A leaked remote worker in one adapter is a real fault, worth
    // reporting — but not grounds to pull the whole hub's readiness probe
    // down (see the comment in src/api/health.ts for why).
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res._body as { status: string; checks: { workerFactory: { status: string; message?: string } } };
    expect(body.status).toBe('degraded');
    expect(body.checks.workerFactory.status).toBe('degraded');
    expect(body.checks.workerFactory.message).toContain('pending broker-side teardown');
  });

  it('still returns 503 when the runtime is not yet initialized, independent of workerFactory health', () => {
    mockIsInitialized.mockReturnValue(false);
    mockGetStatus.mockReturnValue(healthyStatus());
    const res = makeRes();

    routeHandle('/')({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res._body as { status: string };
    expect(body.status).toBe('degraded');
  });
});

describe('GET /health/ready', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
    mockIsInitialized.mockReset();
  });

  it('returns 200 based solely on isInitialized(), even when workerFactory is unhealthy', () => {
    // Deliberate design choice (see src/api/health.ts): a stuck worker
    // teardown is surfaced via GET /health's checks, not by flipping the
    // readiness probe — that would pull the whole hub out of rotation for
    // one adapter's leaked remote worker.
    mockIsInitialized.mockReturnValue(true);
    mockGetStatus.mockReturnValue(healthyStatus({ workerFactoryHealthy: false }));
    const res = makeRes();

    routeHandle('/ready')({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 503 when the runtime is not yet initialized', () => {
    mockIsInitialized.mockReturnValue(false);
    const res = makeRes();

    routeHandle('/ready')({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});
