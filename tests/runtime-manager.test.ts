/**
 * tests/runtime-manager.test.ts
 * Unit tests for src/core/runtime-manager.ts — lifecycle ordering, health
 * aggregation, and request handling. Every collaborator is mocked so the tests
 * exercise only RuntimeManager's own orchestration logic.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/observability/metrics', () => ({
  metrics: { increment: jest.fn(), histogram: jest.fn() },
}));

jest.mock('../src/discovery/registry-manager', () => ({
  registryManager: { listRegistries: jest.fn() },
}));

jest.mock('../src/policy/policy-engine', () => ({
  policyEngine: { listPolicies: jest.fn(), evaluate: jest.fn() },
}));

jest.mock('../src/routing/provider-router', () => ({
  providerRouter: {
    listProviders: jest.fn(),
    startHealthChecks: jest.fn(),
    stopHealthChecks: jest.fn(),
  },
}));

jest.mock('../src/orchestration/workflow-engine', () => ({
  workflowEngine: { listWorkflows: jest.fn() },
}));

jest.mock('../src/routing/capability-selector', () => ({
  capabilitySelector: { select: jest.fn(), recordOutcome: jest.fn() },
}));

jest.mock('../src/routing/scheduler', () => ({
  scheduler: { getStats: jest.fn(), schedule: jest.fn() },
}));

jest.mock('../src/provisioning/runtime-registrar', () => ({
  runtimeRegistrar: { list: jest.fn(), stop: jest.fn() },
}));

jest.mock('../src/normalization/request-normalizer', () => ({
  requestNormalizer: { denormalize: jest.fn() },
}));

jest.mock('../src/adapters/events/index', () => ({
  eventsAdapter: {
    initialize: jest.fn(),
    shutdown: jest.fn(),
    sseClientCount: 0,
  },
}));

jest.mock('../src/adapters/graphql/index', () => ({
  graphqlAdapter: {
    initialize: jest.fn(),
    shutdown: jest.fn(),
    getEndpoints: jest.fn(),
  },
}));

jest.mock('../src/adapters/cli/index', () => ({
  cliAdapter: {
    initialize: jest.fn(),
    shutdown: jest.fn(),
    getRegisteredTools: jest.fn(),
  },
}));

jest.mock('../src/security/credential-broker', () => ({
  credentialBroker: {
    initialize: jest.fn(),
    shutdown: jest.fn(),
    listHandles: jest.fn(),
  },
}));

jest.mock('../src/adapters/upcloud-worker-factory/index', () => ({
  upcloudWorkerFactoryAdapter: {
    initialize: jest.fn(),
    shutdown: jest.fn(),
    listPendingTeardownSessions: jest.fn(),
    listSessions: jest.fn(),
  },
}));

import { RuntimeManager } from '../src/core/runtime-manager';
import { metrics } from '../src/observability/metrics';
import { registryManager } from '../src/discovery/registry-manager';
import { policyEngine } from '../src/policy/policy-engine';
import { providerRouter } from '../src/routing/provider-router';
import { workflowEngine } from '../src/orchestration/workflow-engine';
import { capabilitySelector } from '../src/routing/capability-selector';
import { scheduler } from '../src/routing/scheduler';
import { runtimeRegistrar } from '../src/provisioning/runtime-registrar';
import { requestNormalizer, type NormalizedRequest } from '../src/normalization/request-normalizer';
import { eventsAdapter } from '../src/adapters/events/index';
import { graphqlAdapter } from '../src/adapters/graphql/index';
import { cliAdapter } from '../src/adapters/cli/index';
import { credentialBroker } from '../src/security/credential-broker';
import { upcloudWorkerFactoryAdapter } from '../src/adapters/upcloud-worker-factory/index';

type RegisteredToolStub = { tool: { id: string }; status: string };

const SCHEDULER_STATS = { queued: 0, running: 0 } as unknown as ReturnType<typeof scheduler.getStats>;

/** Records the order in which lifecycle hooks fire. */
let callOrder: string[];

function track(name: string): jest.Mock<Promise<void>, []> {
  return jest.fn(async () => {
    callOrder.push(name);
  });
}

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    id: 'req-1',
    method: 'tools/call',
    params: { toolId: 'tool-a' },
    clientType: 'mcp',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder = [];

  jest.mocked(registryManager.listRegistries).mockReturnValue(['github', 'official']);
  jest.mocked(policyEngine.listPolicies).mockReturnValue([]);
  jest.mocked(policyEngine.evaluate).mockReturnValue({
    allowed: true,
    reasons: [],
  } as unknown as ReturnType<typeof policyEngine.evaluate>);
  jest.mocked(providerRouter.listProviders).mockReturnValue([
    { id: 'p1', name: 'P1', baseUrl: 'http://p1', models: [], maxTokens: 1, capabilities: [] },
  ]);
  jest.mocked(workflowEngine.listWorkflows).mockReturnValue([]);
  jest.mocked(scheduler.getStats).mockReturnValue(SCHEDULER_STATS);
  jest.mocked(runtimeRegistrar.list).mockReturnValue([]);
  jest.mocked(graphqlAdapter.getEndpoints).mockReturnValue([]);
  jest.mocked(cliAdapter.getRegisteredTools).mockReturnValue([]);
  jest.mocked(credentialBroker.listHandles).mockReturnValue([]);
  jest.mocked(upcloudWorkerFactoryAdapter.listPendingTeardownSessions).mockReturnValue([]);
  jest.mocked(upcloudWorkerFactoryAdapter.listSessions).mockReturnValue([]);

  jest.mocked(eventsAdapter.initialize).mockImplementation(track('events.initialize'));
  jest.mocked(graphqlAdapter.initialize).mockImplementation(track('graphql.initialize'));
  jest.mocked(cliAdapter.initialize).mockImplementation(track('cli.initialize'));
  jest.mocked(credentialBroker.initialize).mockImplementation(track('credentialBroker.initialize'));
  jest.mocked(upcloudWorkerFactoryAdapter.initialize).mockImplementation(track('upcloud.initialize'));

  jest.mocked(eventsAdapter.shutdown).mockImplementation(track('events.shutdown'));
  jest.mocked(graphqlAdapter.shutdown).mockImplementation(track('graphql.shutdown'));
  jest.mocked(cliAdapter.shutdown).mockImplementation(track('cli.shutdown'));
  jest.mocked(credentialBroker.shutdown).mockImplementation(track('credentialBroker.shutdown'));
  jest.mocked(upcloudWorkerFactoryAdapter.shutdown).mockImplementation(track('upcloud.shutdown'));

  jest
    .mocked(scheduler.schedule)
    .mockImplementation(async (task: () => Promise<unknown>) => task() as never);
  jest.mocked(requestNormalizer.denormalize).mockImplementation((output) => output);
});

describe('RuntimeManager.initialize()', () => {
  it('starts provider health checks and initializes every adapter in dependency order', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();

    expect(providerRouter.startHealthChecks).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      'events.initialize',
      'graphql.initialize',
      'cli.initialize',
      'credentialBroker.initialize',
      'upcloud.initialize',
    ]);
    expect(manager.isInitialized()).toBe(true);
    expect(metrics.increment).toHaveBeenCalledWith('runtime_initializations_total');
  });

  it('is idempotent: a second call does not re-initialize anything', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();
    await manager.initialize();

    expect(providerRouter.startHealthChecks).toHaveBeenCalledTimes(1);
    expect(eventsAdapter.initialize).toHaveBeenCalledTimes(1);
    expect(upcloudWorkerFactoryAdapter.initialize).toHaveBeenCalledTimes(1);
  });

  it('rethrows an adapter failure and stays uninitialized', async () => {
    jest.mocked(cliAdapter.initialize).mockRejectedValueOnce(new Error('cli boom'));
    const manager = new RuntimeManager();

    await expect(manager.initialize()).rejects.toThrow('cli boom');
    expect(manager.isInitialized()).toBe(false);
    expect(metrics.increment).not.toHaveBeenCalledWith('runtime_initializations_total');
  });

  it('does not initialize the credential broker or worker factory when an earlier adapter fails', async () => {
    jest.mocked(graphqlAdapter.initialize).mockRejectedValueOnce(new Error('graphql boom'));
    const manager = new RuntimeManager();

    await expect(manager.initialize()).rejects.toThrow('graphql boom');
    expect(credentialBroker.initialize).not.toHaveBeenCalled();
    expect(upcloudWorkerFactoryAdapter.initialize).not.toHaveBeenCalled();
  });
});

describe('RuntimeManager.shutdown()', () => {
  it('shuts the worker factory down before the credential broker so leased scopes can be revoked', async () => {
    const manager = new RuntimeManager();
    await manager.initialize();
    callOrder = [];

    await manager.shutdown();

    expect(callOrder).toEqual([
      'events.shutdown',
      'graphql.shutdown',
      'cli.shutdown',
      'upcloud.shutdown',
      'credentialBroker.shutdown',
    ]);
    expect(providerRouter.stopHealthChecks).toHaveBeenCalledTimes(1);
    expect(manager.isInitialized()).toBe(false);
    expect(metrics.increment).toHaveBeenCalledWith('runtime_shutdowns_total');
  });

  it('stops only tools whose status is running', async () => {
    const tools: RegisteredToolStub[] = [
      { tool: { id: 'running-1' }, status: 'running' },
      { tool: { id: 'stopped-1' }, status: 'stopped' },
      { tool: { id: 'running-2' }, status: 'running' },
    ];
    jest.mocked(runtimeRegistrar.list).mockReturnValue(tools as never);

    await new RuntimeManager().shutdown();

    expect(runtimeRegistrar.stop).toHaveBeenCalledTimes(2);
    expect(runtimeRegistrar.stop).toHaveBeenCalledWith('running-1');
    expect(runtimeRegistrar.stop).toHaveBeenCalledWith('running-2');
    expect(runtimeRegistrar.stop).not.toHaveBeenCalledWith('stopped-1');
  });

  it('keeps shutting down when stopping one tool throws', async () => {
    const tools: RegisteredToolStub[] = [
      { tool: { id: 'bad' }, status: 'running' },
      { tool: { id: 'good' }, status: 'running' },
    ];
    jest.mocked(runtimeRegistrar.list).mockReturnValue(tools as never);
    jest.mocked(runtimeRegistrar.stop).mockImplementationOnce(() => {
      throw new Error('cannot stop');
    });

    await expect(new RuntimeManager().shutdown()).resolves.toBeUndefined();

    expect(runtimeRegistrar.stop).toHaveBeenCalledWith('good');
    expect(credentialBroker.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeManager.getStatus()', () => {
  it('reports healthy with every subsystem listed when nothing is wrong', () => {
    const status = new RuntimeManager().getStatus();

    expect(status.healthy).toBe(true);
    expect(status.subsystems.map((s) => s.name)).toEqual([
      'installer',
      'registry',
      'policy-engine',
      'provider-router',
      'workflow-engine',
      'scheduler',
      'events-adapter',
      'graphql-adapter',
      'cli-adapter',
      'credential-broker',
      'upcloud-worker-factory',
    ]);
    expect(status.subsystems.every((s) => s.healthy)).toBe(true);
    expect(status.schedulerStats).toBe(SCHEDULER_STATS);
    expect(() => new Date(status.timestamp).toISOString()).not.toThrow();
  });

  it('counts installed and running tools', () => {
    const tools: RegisteredToolStub[] = [
      { tool: { id: 'a' }, status: 'running' },
      { tool: { id: 'b' }, status: 'registered' },
      { tool: { id: 'c' }, status: 'running' },
    ];
    jest.mocked(runtimeRegistrar.list).mockReturnValue(tools as never);

    const status = new RuntimeManager().getStatus();

    expect(status.installedTools).toBe(3);
    expect(status.runningTools).toBe(2);
  });

  it('is unhealthy when no registries are configured', () => {
    jest.mocked(registryManager.listRegistries).mockReturnValue([]);

    const status = new RuntimeManager().getStatus();

    expect(status.healthy).toBe(false);
    expect(status.subsystems.find((s) => s.name === 'registry')?.healthy).toBe(false);
  });

  it('is unhealthy when no providers are configured', () => {
    jest.mocked(providerRouter.listProviders).mockReturnValue([]);

    const status = new RuntimeManager().getStatus();

    expect(status.healthy).toBe(false);
    expect(status.subsystems.find((s) => s.name === 'provider-router')?.healthy).toBe(false);
  });

  it('surfaces pending worker-session teardowns as an unhealthy upcloud-worker-factory subsystem', () => {
    jest
      .mocked(upcloudWorkerFactoryAdapter.listPendingTeardownSessions)
      .mockReturnValue([{ sessionId: 's1' }, { sessionId: 's2' }] as never);
    jest
      .mocked(upcloudWorkerFactoryAdapter.listSessions)
      .mockReturnValue([{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }] as never);

    const status = new RuntimeManager().getStatus();
    const workerFactory = status.subsystems.find((s) => s.name === 'upcloud-worker-factory');

    expect(workerFactory?.healthy).toBe(false);
    expect(workerFactory?.detail).toBe('3 active worker sessions (2 pending broker-side teardown)');
    expect(status.healthy).toBe(false);
  });

  it('reports a plain session count when no teardown is pending', () => {
    jest
      .mocked(upcloudWorkerFactoryAdapter.listSessions)
      .mockReturnValue([{ sessionId: 's1' }] as never);

    const workerFactory = new RuntimeManager()
      .getStatus()
      .subsystems.find((s) => s.name === 'upcloud-worker-factory');

    expect(workerFactory).toEqual({
      name: 'upcloud-worker-factory',
      healthy: true,
      detail: '1 active worker sessions',
    });
  });
});

describe('RuntimeManager.handleRequest()', () => {
  it('evaluates policy with the request actor, action and tool id', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue(null);

    await new RuntimeManager().handleRequest(makeRequest({ clientType: 'rest', method: 'tools/list' }));

    expect(policyEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'tool-a', actor: 'rest', action: 'tools/list' }),
    );
  });

  it('falls back to toolId "unknown" when the request does not name a tool', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue(null);

    await new RuntimeManager().handleRequest(makeRequest({ params: {} }));

    expect(policyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'unknown' }));
  });

  it('throws and records a failure metric when policy denies the request', async () => {
    jest.mocked(policyEngine.evaluate).mockReturnValue({
      allowed: false,
      reasons: ['blocked by rule A', 'blocked by rule B'],
    } as unknown as ReturnType<typeof policyEngine.evaluate>);

    await expect(new RuntimeManager().handleRequest(makeRequest())).rejects.toThrow(
      'Policy denied: blocked by rule A, blocked by rule B',
    );

    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('requests_handled_total', {
      method: 'tools/call',
      success: 'false',
    });
  });

  it('handles a request with no matching tool and reports toolId null', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue(null);

    const result = (await new RuntimeManager().handleRequest(makeRequest())) as Record<string, unknown>;

    expect(result).toMatchObject({ requestId: 'req-1', method: 'tools/call', toolId: null, handled: true });
    expect(capabilitySelector.recordOutcome).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('requests_handled_total', {
      method: 'tools/call',
      success: 'true',
    });
  });

  it('records a successful outcome against the selected tool', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue({
      tool: { tool: { id: 'tool-a' } },
      score: 10,
      reasons: [],
    } as never);

    const result = (await new RuntimeManager().handleRequest(makeRequest())) as Record<string, unknown>;

    expect(result).toMatchObject({ toolId: 'tool-a' });
    expect(capabilitySelector.recordOutcome).toHaveBeenCalledWith('tool-a', true, expect.any(Number));
  });

  it('denormalizes the output for the originating client type', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue(null);

    await new RuntimeManager().handleRequest(makeRequest({ clientType: 'graphql' }));

    expect(requestNormalizer.denormalize).toHaveBeenCalledWith(expect.any(Object), 'graphql');
  });

  it('propagates scheduler failures and records a failure metric', async () => {
    jest.mocked(capabilitySelector.select).mockReturnValue(null);
    jest.mocked(scheduler.schedule).mockRejectedValueOnce(new Error('queue full'));

    await expect(new RuntimeManager().handleRequest(makeRequest())).rejects.toThrow('queue full');

    expect(metrics.histogram).toHaveBeenCalledWith('request_handling_duration_ms', expect.any(Number));
    expect(metrics.increment).toHaveBeenCalledWith('requests_handled_total', {
      method: 'tools/call',
      success: 'false',
    });
  });
});
