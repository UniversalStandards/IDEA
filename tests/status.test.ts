/**
 * tests/status.test.ts
 * Unit tests for src/api/status.ts — specifically GET /status's
 * workerFactoryHealthy/workerFactoryDetail fields, which read
 * runtimeManager.getStatus()'s own 'upcloud-worker-factory' subsystem entry
 * rather than duplicating that computation.
 *
 * Every real dependency of status.ts is mocked at the module level. For
 * runtimeManager specifically, this also sidesteps a pre-existing,
 * unrelated compile error in its own transitive imports
 * (capability-selector.ts, request-normalizer.ts, cli/index.ts — see
 * CHANGELOG.md's "Known issue" entries): mocking the module means ts-jest
 * never needs to type-check its real implementation.
 */

const mockGetStatus = jest.fn();

jest.mock('../src/core/runtime-manager', () => ({
  runtimeManager: { getStatus: () => mockGetStatus() },
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { getSnapshot: jest.fn(() => ({})) },
}));

jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: { list: jest.fn(() => []) },
}));

jest.mock('../src/orchestration/workflow-engine', () => ({
  workflowEngine: { listWorkflows: jest.fn(() => []) },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: { listPolicies: jest.fn(() => []) },
}));

jest.mock('../src/routing/provider-router', () => ({
  providerRouter: { listProviders: jest.fn(() => []), checkHealth: jest.fn() },
}));

import { statusRouter } from '../src/api/status';

type MockRes = {
  status: jest.Mock;
  json: jest.Mock;
  _body: unknown;
};

function makeRes(): MockRes {
  const res = { status: jest.fn(), json: jest.fn(), _body: null } as MockRes;
  res.status.mockReturnValue(res);
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

function routeHandle(path: string): (req: unknown, res: unknown) => void {
  const layer = (
    statusRouter as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } }>;
    }
  ).stack.find((l) => l.route?.path === path);
  if (!layer?.route) {
    throw new Error(`statusRouter has no registered route for '${path}'`);
  }
  return layer.route.stack[0]!.handle;
}

describe('GET /status', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
  });

  it('reports workerFactoryHealthy: true and no detail of concern when no sessions are pending teardown', () => {
    mockGetStatus.mockReturnValue({
      healthy: true,
      subsystems: [{ name: 'upcloud-worker-factory', healthy: true, detail: '0 active worker sessions' }],
      installedTools: 0,
      runningTools: 0,
      schedulerStats: {},
      timestamp: new Date().toISOString(),
    });
    const res = makeRes();

    routeHandle('/')({}, res);

    const body = res._body as { hub: { workerFactoryHealthy: boolean; workerFactoryDetail: string } };
    expect(body.hub.workerFactoryHealthy).toBe(true);
    expect(body.hub.workerFactoryDetail).toBe('0 active worker sessions');
  });

  it('surfaces workerFactoryHealthy: false and the pending-teardown count, instead of omitting the fault', () => {
    mockGetStatus.mockReturnValue({
      healthy: false,
      subsystems: [
        {
          name: 'upcloud-worker-factory',
          healthy: false,
          detail: '3 active worker sessions (1 pending broker-side teardown)',
        },
      ],
      installedTools: 0,
      runningTools: 0,
      schedulerStats: {},
      timestamp: new Date().toISOString(),
    });
    const res = makeRes();

    routeHandle('/')({}, res);

    const body = res._body as { hub: { workerFactoryHealthy: boolean; workerFactoryDetail: string } };
    expect(body.hub.workerFactoryHealthy).toBe(false);
    expect(body.hub.workerFactoryDetail).toContain('pending broker-side teardown');
  });
});
