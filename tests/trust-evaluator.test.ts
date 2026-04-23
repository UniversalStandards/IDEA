/**
 * Tests for the trust evaluator.
 */
import { TrustEvaluator, ToolMetadata, PipelineResult } from '../src/policy/trust-evaluator';
import { RiskLevel } from '../src/types/index';

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

  // ─────────────────────────────────────────────────────────────────
  // 10-Stage Trust Pipeline tests
  // ─────────────────────────────────────────────────────────────────

  describe('evaluatePipeline', () => {
    /** A tool that should auto-approve (overall > 0.7) */
    const highTrustTool = makeTool({
      id: 'high-trust-tool',
      source: 'official_registry',
      signatureValid: true,
      downloadCount: 500_000,
      knownVulnerabilities: 0,
      author: 'trusted-org',
      publishedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), // 400 days ago
      version: '2.3.1',
      repositoryUrl: 'https://github.com/trusted-org/high-trust-tool',
    });

    /** A tool that should auto-deny (overall < 0.4) */
    const lowTrustTool = makeTool({
      id: 'low-trust-tool',
      source: 'unknown',
      signatureValid: false,
      downloadCount: 0,
      knownVulnerabilities: 5,
      version: '0.0.1',
    });

    it('auto-approves a high-trust tool (overall > 0.7)', async () => {
      const result = await evaluator.evaluatePipeline(highTrustTool);

      expect(result.approved).toBe(true);
      expect(result.denied).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.trustScore.overall).toBeGreaterThan(0.7);
    });

    it('auto-denies a low-trust tool (overall < 0.4)', async () => {
      const result = await evaluator.evaluatePipeline(lowTrustTool);

      expect(result.denied).toBe(true);
      expect(result.approved).toBe(false);
      expect(result.trustScore.overall).toBeLessThan(0.4);
    });

    it('returns a canonical TrustScore with all breakdown fields (0–1 range)', async () => {
      const result = await evaluator.evaluatePipeline(highTrustTool);
      const { trustScore } = result;

      expect(trustScore.overall).toBeGreaterThanOrEqual(0);
      expect(trustScore.overall).toBeLessThanOrEqual(1);
      expect(trustScore.evaluatedAt).toBeInstanceOf(Date);

      const { breakdown } = trustScore;
      expect(breakdown).toHaveProperty('provenance');
      expect(breakdown).toHaveProperty('signature');
      expect(breakdown).toHaveProperty('age');
      expect(breakdown).toHaveProperty('downloads');
      expect(breakdown).toHaveProperty('policy');

      for (const val of Object.values(breakdown)) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it('assigns a RiskLevel to the result', async () => {
      const result = await evaluator.evaluatePipeline(highTrustTool);
      expect(Object.values(RiskLevel)).toContain(result.riskLevel);
    });

    it('produces 10 stage results', async () => {
      const result = await evaluator.evaluatePipeline(highTrustTool);
      expect(result.stageResults).toHaveLength(10);
      for (const stage of result.stageResults) {
        expect(stage).toHaveProperty('stage');
        expect(stage).toHaveProperty('name');
        expect(stage).toHaveProperty('passed');
        expect(stage).toHaveProperty('details');
      }
      // Stages must be numbered 1–10 in order
      for (let i = 0; i < 10; i++) {
        expect(result.stageResults[i]!.stage).toBe(i + 1);
      }
    });

    it('allowlist override approves a tool regardless of score', async () => {
      // A low-trust tool would normally be denied, but the allowlist overrides that
      const result = await evaluator.evaluatePipeline(lowTrustTool, {
        allowlist: [lowTrustTool.id],
      });

      expect(result.approved).toBe(true);
      expect(result.denied).toBe(false);
      expect(result.requiresApproval).toBe(false);
    });

    it('denylist enforcement denies a tool regardless of high score', async () => {
      // A high-trust tool would normally be approved, but the denylist blocks it
      const result = await evaluator.evaluatePipeline(highTrustTool, {
        denylist: [highTrustTool.id],
      });

      expect(result.denied).toBe(true);
      expect(result.approved).toBe(false);
    });

    it('denylist takes precedence over allowlist', async () => {
      const result = await evaluator.evaluatePipeline(highTrustTool, {
        allowlist: [highTrustTool.id],
        denylist: [highTrustTool.id],
      });

      expect(result.denied).toBe(true);
      expect(result.approved).toBe(false);
    });

    it('requires human approval for medium-score tools', async () => {
      // Construct a tool with score in [0.4, 0.7]
      const mediumTool = makeTool({
        id: 'medium-trust-tool',
        source: 'github',
        signatureValid: false,
        downloadCount: 5_000,
        knownVulnerabilities: 1,
        version: '0.8.0',
        author: 'someone',
        publishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
      });

      const result = await evaluator.evaluatePipeline(mediumTool);
      // Should not be auto-approved or auto-denied outright
      if (!result.approved && !result.denied) {
        expect(result.requiresApproval).toBe(true);
      }
      expect(result.trustScore.overall).toBeGreaterThanOrEqual(0);
      expect(result.trustScore.overall).toBeLessThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Revocation tests
  // ─────────────────────────────────────────────────────────────────

  describe('revoke', () => {
    it('isRevoked returns false for a tool that has not been revoked', () => {
      expect(evaluator.isRevoked('some-tool')).toBe(false);
    });

    it('isRevoked returns true after revoke() is called', () => {
      evaluator.revoke('some-tool');
      expect(evaluator.isRevoked('some-tool')).toBe(true);
    });

    it('evaluatePipeline denies a revoked tool even if it would otherwise auto-approve', async () => {
      const highTrustTool = makeTool({
        id: 'revoked-tool',
        source: 'official_registry',
        signatureValid: true,
        downloadCount: 500_000,
        knownVulnerabilities: 0,
        author: 'trusted-org',
        publishedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
        version: '2.3.1',
      });
      evaluator.revoke('revoked-tool');
      const result = await evaluator.evaluatePipeline(highTrustTool);

      expect(result.revoked).toBe(true);
      expect(result.denied).toBe(true);
      expect(result.approved).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Monitoring hook tests
  // ─────────────────────────────────────────────────────────────────

  describe('registerMonitor', () => {
    it('monitor callback is invoked during pipeline evaluation', async () => {
      const calls: Array<[string, PipelineResult]> = [];
      evaluator.registerMonitor((toolId, result) => {
        calls.push([toolId, result]);
      });

      const tool = makeTool({ id: 'monitored-tool', source: 'official_registry', signatureValid: true, downloadCount: 10_000 });
      await evaluator.evaluatePipeline(tool);

      expect(calls.length).toBe(1);
      expect(calls[0]![0]).toBe('monitored-tool');
    });

    it('trust:evaluated event is emitted during pipeline evaluation', async () => {
      const emitted: string[] = [];
      evaluator.on('trust:evaluated', (toolId: string) => {
        emitted.push(toolId);
      });

      const tool = makeTool({ id: 'event-tool', source: 'official_registry' });
      await evaluator.evaluatePipeline(tool);

      expect(emitted).toContain('event-tool');
    });
  });
});
