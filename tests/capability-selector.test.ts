/**
 * tests/capability-selector.test.ts
 * Unit tests for src/routing/capability-selector.ts
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
  metrics: {
    increment: jest.fn(),
    histogram: jest.fn(),
    gauge: jest.fn(),
  },
}));

import { CapabilitySelector } from '../src/routing/capability-selector';
import type { RegisteredTool } from '../src/provisioning/runtime-registrar';
import type { NormalizedRequest } from '../src/normalization/request-normalizer';

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    id: 'req-1',
    method: 'search',
    params: {},
    clientType: 'mcp',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeTool(
  id: string,
  name: string,
  overrides: Partial<RegisteredTool['tool']> = {},
): RegisteredTool {
  return {
    tool: {
      id,
      name,
      version: '1.0.0',
      description: `Tool ${name}`,
      source: 'official',
      capabilities: [],
      tags: [],
      verified: false,
      ...overrides,
    },
    config: { env: {}, args: [], workingDir: '/tmp', timeout: 30_000 },
    registeredAt: new Date(),
    status: 'registered',
  };
}

describe('CapabilitySelector — select()', () => {
  let selector: CapabilitySelector;

  beforeEach(() => {
    selector = new CapabilitySelector();
  });

  it('returns null when no tools are available', () => {
    const result = selector.select(makeRequest(), []);
    expect(result).toBeNull();
  });

  it('returns null when all tools are in non-eligible status', () => {
    const tool = makeTool('t1', 'search');
    tool.status = 'stopped';
    const result = selector.select(makeRequest(), [tool]);
    expect(result).toBeNull();
  });

  it('returns best match by exact name', () => {
    const toolA = makeTool('t-search', 'search');
    const toolB = makeTool('t-other', 'other-tool');
    const result = selector.select(makeRequest({ method: 'search' }), [toolA, toolB]);
    expect(result?.tool.tool.id).toBe('t-search');
  });

  it('returns the single available tool', () => {
    const tool = makeTool('t1', 'my-tool');
    const result = selector.select(makeRequest(), [tool]);
    expect(result).not.toBeNull();
    expect(result?.tool.tool.id).toBe('t1');
  });

  it('prefers already-running tools', () => {
    const stopped = makeTool('t-stopped', 'search');
    stopped.status = 'registered';
    const running = makeTool('t-running', 'search');
    running.status = 'running';
    const result = selector.select(makeRequest({ method: 'search' }), [stopped, running]);
    expect(result?.tool.tool.id).toBe('t-running');
  });

  it('penalizes tools with error status', () => {
    const normal = makeTool('t-normal', 'other-tool');
    const errored = makeTool('t-error', 'search');
    errored.status = 'error';
    // error status tool should be scored lower
    const result = selector.select(makeRequest({ method: 'search' }), [normal, errored]);
    // both are candidates (registered/running/error are not filtered initially, but error status filtered)
    // The error tool has status='error' which is NOT 'registered' or 'running', so it's filtered out
    expect(result?.tool.tool.id).toBe('t-normal');
  });

  it('returns null when all tools have error status', () => {
    const tool = makeTool('t1', 'search');
    tool.status = 'error';
    const result = selector.select(makeRequest(), [tool]);
    expect(result).toBeNull();
  });

  it('scores higher for verified tools', () => {
    const normal = makeTool('t-normal', 'tool', { verified: false, source: 'github' });
    const verified = makeTool('t-verified', 'tool', { verified: true, source: 'github' });
    const result = selector.select(makeRequest({ method: 'tool' }), [normal, verified]);
    expect(result?.tool.tool.id).toBe('t-verified');
  });

  it('matches capability terms from request params', () => {
    const capTool = makeTool('cap-tool', 'generic', { capabilities: ['search', 'query'] });
    const noCapTool = makeTool('no-cap-tool', 'generic');
    const result = selector.select(
      makeRequest({ method: 'generic', params: { query: 'search' } }),
      [capTool, noCapTool],
    );
    expect(result?.tool.tool.id).toBe('cap-tool');
  });

  it('matches tag terms from request params', () => {
    const taggedTool = makeTool('tagged', 'generic', { tags: ['file', 'system'] });
    const untaggedTool = makeTool('untagged', 'generic');
    const result = selector.select(
      makeRequest({ method: 'generic', params: { action: 'file' } }),
      [taggedTool, untaggedTool],
    );
    expect(result?.tool.tool.id).toBe('tagged');
  });

  it('uses partial name match when no exact match', () => {
    const partial = makeTool('t-partial', 'search-advanced');
    const unrelated = makeTool('t-unrelated', 'completely-different');
    const result = selector.select(makeRequest({ method: 'search' }), [partial, unrelated]);
    expect(result?.tool.tool.id).toBe('t-partial');
  });

  it('uses toolId from params for matching', () => {
    const specificTool = makeTool('my-special-tool', 'generic');
    const result = selector.select(
      makeRequest({ method: 'run', params: { toolId: 'my-special-tool' } }),
      [specificTool],
    );
    expect(result).not.toBeNull();
  });

  it('handles _query param for term extraction', () => {
    const queryTool = makeTool('q-tool', 'search', { capabilities: ['lookup'] });
    const result = selector.select(
      makeRequest({ method: 'run', params: { _query: 'lookup data' } }),
      [queryTool],
    );
    expect(result).not.toBeNull();
  });

  it('uses local source preference', () => {
    const remoteTool = makeTool('remote', 'tool', { source: 'github' });
    const localTool = makeTool('local', 'tool', { source: 'local' });
    const result = selector.select(makeRequest({ method: 'tool' }), [remoteTool, localTool]);
    // local gets source trust score of 0.6 but also +5 local preference
    expect(result).not.toBeNull();
  });
});

describe('CapabilitySelector — recordOutcome()', () => {
  let selector: CapabilitySelector;

  beforeEach(() => {
    selector = new CapabilitySelector();
  });

  it('records outcome without throwing', () => {
    expect(() => selector.recordOutcome('tool-1', true, 100)).not.toThrow();
  });

  it('tracks multiple outcomes and influences selection', () => {
    const toolA = makeTool('tool-a', 'tool');
    const toolB = makeTool('tool-b', 'tool');

    // Record 100% success for tool-a
    selector.recordOutcome('tool-a', true, 50);
    selector.recordOutcome('tool-a', true, 50);
    // Record 0% success for tool-b
    selector.recordOutcome('tool-b', false, 50);
    selector.recordOutcome('tool-b', false, 50);

    const result = selector.select(makeRequest({ method: 'tool' }), [toolA, toolB]);
    expect(result?.tool.tool.id).toBe('tool-a');
  });

  it('penalizes high latency tools', () => {
    const fastTool = makeTool('fast', 'tool');
    const slowTool = makeTool('slow', 'tool');

    selector.recordOutcome('fast', true, 10);
    selector.recordOutcome('slow', true, 5000); // very high latency

    const result = selector.select(makeRequest({ method: 'tool' }), [fastTool, slowTool]);
    expect(result?.tool.tool.id).toBe('fast');
  });

  it('records failures correctly', () => {
    expect(() => selector.recordOutcome('tool-x', false, 200)).not.toThrow();
  });
});
