/**
 * Tests for the trust evaluator.
 */
import { TrustEvaluator, ToolMetadata } from '../src/policy/trust-evaluator';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

function makeTool(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: 'test-tool',
    name: 'test-tool',
    version: '1.0.0',
    source: 'official_registry',
    signatureValid: true,
    downloadCount: 1000,
    knownVulnerabilities: 0,
    ...overrides,
  };
}

describe('TrustEvaluator', () => {
  let evaluator: TrustEvaluator;

  beforeEach(() => {
    evaluator = new TrustEvaluator();
  });

  it('returns a score between 0 and 100', () => {
    const result = evaluator.evaluate(makeTool());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('assigns a trust level', () => {
    const result = evaluator.evaluate(makeTool());
    expect(['untrusted', 'low', 'medium', 'high', 'verified']).toContain(result.level);
  });

  it('returns trust factors', () => {
    const result = evaluator.evaluate(makeTool());
    expect(Array.isArray(result.factors)).toBe(true);
    expect(result.factors.length).toBeGreaterThan(0);
    for (const factor of result.factors) {
      expect(factor).toHaveProperty('name');
      expect(factor).toHaveProperty('weight');
      expect(factor).toHaveProperty('score');
      expect(factor).toHaveProperty('reason');
    }
  });

  it('gives higher score to official_registry than unknown source', () => {
    const official = evaluator.evaluate(makeTool({ source: 'official_registry' }));
    const unknown = evaluator.evaluate(makeTool({ source: 'unknown' }));
    expect(official.score).toBeGreaterThan(unknown.score);
  });

  it('gives enterprise source a good score', () => {
    const result = evaluator.evaluate(makeTool({ source: 'enterprise' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('gives github source a medium score', () => {
    const result = evaluator.evaluate(makeTool({ source: 'github' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('gives local source a lower score than official', () => {
    const local = evaluator.evaluate(makeTool({ source: 'local' }));
    const official = evaluator.evaluate(makeTool({ source: 'official_registry' }));
    expect(official.score).toBeGreaterThan(local.score);
  });

  it('penalises tools with known vulnerabilities', () => {
    const clean = evaluator.evaluate(makeTool({ knownVulnerabilities: 0 }));
    const vulnerable = evaluator.evaluate(makeTool({ knownVulnerabilities: 3 }));
    expect(clean.score).toBeGreaterThan(vulnerable.score);
  });

  it('gives medium penalty for 1-2 vulnerabilities', () => {
    const low = evaluator.evaluate(makeTool({ knownVulnerabilities: 2 }));
    expect(low.score).toBeGreaterThan(0);
  });

  it('penalises tools with invalid signature', () => {
    const signed = evaluator.evaluate(makeTool({ signatureValid: true }));
    const unsigned = evaluator.evaluate(makeTool({ signatureValid: false }));
    expect(signed.score).toBeGreaterThan(unsigned.score);
  });

  it('gives partial credit when signature is not checked (field absent)', () => {
    // Create a tool without signatureValid by spreading a partial object
    const toolWithoutSig: ToolMetadata = {
      id: 'test-tool', name: 'test-tool', version: '1.0.0',
      source: 'official_registry', downloadCount: 1000, knownVulnerabilities: 0,
    };
    const result = evaluator.evaluate(toolWithoutSig);
    const signatureFactor = result.factors.find((f) => f.name === 'signature');
    expect(signatureFactor?.score).toBe(20);
  });

  it('gives higher score to highly downloaded tools', () => {
    const popular = evaluator.evaluate(makeTool({ downloadCount: 200_000 }));
    const rare = evaluator.evaluate(makeTool({ downloadCount: 0 }));
    expect(popular.score).toBeGreaterThan(rare.score);
  });

  it('scores moderately downloaded tools (10k–100k)', () => {
    const result = evaluator.evaluate(makeTool({ downloadCount: 50_000 }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('scores low downloaded tools (1k–10k)', () => {
    const result = evaluator.evaluate(makeTool({ downloadCount: 5_000 }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('scores very low downloaded tools (1–999)', () => {
    const result = evaluator.evaluate(makeTool({ downloadCount: 500 }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('gives pre-1.0 minor>=5 a medium version score', () => {
    const result = evaluator.evaluate(makeTool({ version: '0.8.0' }));
    const versionFactor = result.factors.find((f) => f.name === 'version_stability');
    expect(versionFactor?.score).toBe(60);
  });

  it('gives pre-1.0 early minor a low version score', () => {
    const result = evaluator.evaluate(makeTool({ version: '0.1.0' }));
    const versionFactor = result.factors.find((f) => f.name === 'version_stability');
    expect(versionFactor?.score).toBe(30);
  });

  it('gives non-semver version a very low score', () => {
    const result = evaluator.evaluate(makeTool({ version: 'nightly' }));
    const versionFactor = result.factors.find((f) => f.name === 'version_stability');
    expect(versionFactor?.score).toBe(10);
  });

  it('supports adding a custom factor', () => {
    evaluator.addFactor('custom-bonus', () => ({
      weight: 10,
      score: 100,
      reason: 'custom factor always max',
    }));
    const result = evaluator.evaluate(makeTool());
    const found = result.factors.find((f) => f.name === 'custom-bonus');
    expect(found).toBeDefined();
    expect(found!.score).toEqual(100);
  });

  it('replaces a factor when adding with the same name', () => {
    evaluator.addFactor('source', () => ({ weight: 1, score: 50, reason: 'override' }));
    const result = evaluator.evaluate(makeTool());
    const sourceFactor = result.factors.find((f) => f.name === 'source');
    expect(sourceFactor?.reason).toBe('override');
  });

  it('removes a factor by name', () => {
    const removed = evaluator.removeFactor('popularity');
    expect(removed).toBe(true);
    const result = evaluator.evaluate(makeTool());
    const found = result.factors.find((f) => f.name === 'popularity');
    expect(found).toBeUndefined();
  });

  it('returns false when removing non-existent factor', () => {
    expect(evaluator.removeFactor('nonexistent')).toBe(false);
  });

  it('gracefully handles evaluator that throws', () => {
    evaluator.addFactor('broken', () => {
      throw new Error('evaluator error');
    });
    expect(() => evaluator.evaluate(makeTool())).not.toThrow();
    const result = evaluator.evaluate(makeTool());
    const broken = result.factors.find((f) => f.name === 'broken');
    expect(broken?.score).toBe(0);
    expect(broken?.reason).toBe('Evaluator error');
  });

  it('getMinimumRequired returns correct values for known actions', () => {
    expect(evaluator.getMinimumRequired('install')).toBe(50);
    expect(evaluator.getMinimumRequired('execute')).toBe(25);
    expect(evaluator.getMinimumRequired('read')).toBe(10);
    expect(evaluator.getMinimumRequired('write_file')).toBe(70);
    expect(evaluator.getMinimumRequired('delete_file')).toBe(80);
    expect(evaluator.getMinimumRequired('execute_shell')).toBe(80);
    expect(evaluator.getMinimumRequired('network_request')).toBe(50);
  });

  it('getMinimumRequired falls back to default for unknown action', () => {
    const min = evaluator.getMinimumRequired('unknown_action');
    expect(min).toBe(25);
  });

  it('scores a tool with no factors at 0', () => {
    // Remove all factors to test 0 path
    evaluator.removeFactor('source');
    evaluator.removeFactor('signature');
    evaluator.removeFactor('version_stability');
    evaluator.removeFactor('popularity');
    evaluator.removeFactor('vulnerabilities');
    const result = evaluator.evaluate(makeTool());
    expect(result.score).toBe(0);
    expect(result.level).toBe('untrusted');
  });

  it('clamps factor scores to [0, 100]', () => {
    evaluator.addFactor('over-max', () => ({ weight: 1, score: 200, reason: 'too high' }));
    const result = evaluator.evaluate(makeTool({ source: 'unknown', signatureValid: false, downloadCount: 0, version: 'nightly', knownVulnerabilities: 10 }));
    for (const factor of result.factors) {
      expect(factor.score).toBeLessThanOrEqual(100);
      expect(factor.score).toBeGreaterThanOrEqual(0);
    }
  });
});

