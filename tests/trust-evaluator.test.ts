/**
 * Tests for the trust evaluator.
 */
import { TrustEvaluator, ToolMetadata } from '../src/policy/trust-evaluator';

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

  it('penalises tools with known vulnerabilities', () => {
    const clean = evaluator.evaluate(makeTool({ knownVulnerabilities: 0 }));
    const vulnerable = evaluator.evaluate(makeTool({ knownVulnerabilities: 3 }));
    expect(clean.score).toBeGreaterThan(vulnerable.score);
  });

  it('penalises tools with invalid signature', () => {
    const signed = evaluator.evaluate(makeTool({ signatureValid: true }));
    const unsigned = evaluator.evaluate(makeTool({ signatureValid: false }));
    expect(signed.score).toBeGreaterThan(unsigned.score);
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

  it('getMinimumRequired returns a number', () => {
    const min = evaluator.getMinimumRequired('execute');
    expect(typeof min).toEqual('number');
    expect(min).toBeGreaterThanOrEqual(0);
  });
});
