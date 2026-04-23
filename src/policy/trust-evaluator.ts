import { EventEmitter } from 'events';
import { createLogger } from '../observability/logger';
import { auditLog } from '../security/audit';
import { approvalGate } from './approval-gates';
import { RiskLevel } from '../types/index';
import type { TrustScore as CanonicalTrustScore } from '../types/index';

const logger = createLogger('trust-evaluator');

export interface ToolMetadata {
  id: string;
  name: string;
  version: string;
  source: 'official_registry' | 'github' | 'enterprise' | 'local' | 'unknown';
  signatureValid?: boolean;
  downloadCount?: number;
  knownVulnerabilities?: number;
  author?: string;
  publishedAt?: string;
  /** SLSA provenance level (0–4). Supply via `metadata.slsaLevel` or this field. */
  slsaLevel?: 0 | 1 | 2 | 3 | 4;
  /** Source repository URL for provenance validation. */
  repositoryUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface TrustFactor {
  name: string;
  weight: number;
  score: number;
  reason: string;
}

export interface TrustScore {
  score: number;
  level: 'untrusted' | 'low' | 'medium' | 'high' | 'verified';
  factors: TrustFactor[];
}

// ─────────────────────────────────────────────────────────────────
// Pipeline types
// ─────────────────────────────────────────────────────────────────

export interface PipelineStageResult {
  readonly stage: number;
  readonly name: string;
  readonly passed: boolean;
  readonly details: string;
}

export interface PipelineResult {
  /** Canonical trust score conforming to src/types/index.ts TrustScore */
  readonly trustScore: CanonicalTrustScore;
  readonly riskLevel: RiskLevel;
  readonly approved: boolean;
  readonly requiresApproval: boolean;
  readonly denied: boolean;
  readonly revoked: boolean;
  readonly stageResults: PipelineStageResult[];
}

export interface PipelineOptions {
  /** Tool IDs explicitly allowed — bypasses score threshold and auto-approves. */
  allowlist?: string[];
  /** Tool IDs explicitly denied — overrides all other evaluation and auto-denies. */
  denylist?: string[];
  /** Identity requesting the action (used for approval-gate audit trail). */
  requestedBy?: string;
  /** Action being requested (e.g. 'install', 'execute'). */
  action?: string;
}

type MonitorCallback = (toolId: string, result: PipelineResult) => void;

type FactorEvaluator = (tool: ToolMetadata) => Omit<TrustFactor, 'name'>;

const DEFAULT_FACTORS: Array<{ name: string; evaluator: FactorEvaluator }> = [
  {
    name: 'source',
    evaluator: (tool) => {
      const scoreMap: Record<ToolMetadata['source'], number> = {
        official_registry: 100,
        enterprise: 85,
        github: 60,
        local: 40,
        unknown: 5,
      };
      const score = scoreMap[tool.source] ?? 5;
      return {
        weight: 0.30,
        score,
        reason: `Source is ${tool.source} (score: ${score})`,
      };
    },
  },
  {
    name: 'signature',
    evaluator: (tool) => {
      if (tool.signatureValid === true) {
        return { weight: 0.25, score: 100, reason: 'Package signature is valid' };
      }
      if (tool.signatureValid === false) {
        return { weight: 0.25, score: 0, reason: 'Package signature is invalid' };
      }
      return { weight: 0.25, score: 20, reason: 'Package signature not checked' };
    },
  },
  {
    name: 'version_stability',
    evaluator: (tool) => {
      const semverRegex = /^(\d+)\.(\d+)\.(\d+)/;
      const match = semverRegex.exec(tool.version);
      if (!match) return { weight: 0.15, score: 10, reason: 'Non-semver version string' };
      const major = parseInt(match[1]!, 10);
      if (major >= 1) return { weight: 0.15, score: 90, reason: 'Stable major version >= 1' };
      if (major === 0) {
        const minor = parseInt(match[2]!, 10);
        if (minor >= 5) return { weight: 0.15, score: 60, reason: 'Pre-1.0 but minor >= 5' };
        return { weight: 0.15, score: 30, reason: 'Pre-1.0 early-stage version' };
      }
      return { weight: 0.15, score: 10, reason: 'Unrecognized version pattern' };
    },
  },
  {
    name: 'popularity',
    evaluator: (tool) => {
      const downloads = tool.downloadCount ?? 0;
      let score: number;
      let reason: string;
      if (downloads >= 100_000) {
        score = 100;
        reason = `High download count: ${downloads}`;
      } else if (downloads >= 10_000) {
        score = 80;
        reason = `Moderate download count: ${downloads}`;
      } else if (downloads >= 1_000) {
        score = 60;
        reason = `Low download count: ${downloads}`;
      } else if (downloads > 0) {
        score = 30;
        reason = `Very low download count: ${downloads}`;
      } else {
        score = 10;
        reason = 'No download data available';
      }
      return { weight: 0.15, score, reason };
    },
  },
  {
    name: 'vulnerabilities',
    evaluator: (tool) => {
      const vulns = tool.knownVulnerabilities ?? 0;
      if (vulns === 0) {
        return { weight: 0.15, score: 100, reason: 'No known vulnerabilities' };
      }
      if (vulns <= 2) {
        return { weight: 0.15, score: 40, reason: `${vulns} known vulnerabilities` };
      }
      return { weight: 0.15, score: 0, reason: `${vulns} known vulnerabilities — high risk` };
    },
  },
];

function scoreToLevel(score: number): TrustScore['level'] {
  if (score >= 90) return 'verified';
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 25) return 'low';
  return 'untrusted';
}

/** Maps a canonical 0–1 overall score to a `RiskLevel` string (imported type). */
function scoreToRiskLevel(overall: number): RiskLevel {
  if (overall >= 0.7) return RiskLevel.LOW;
  if (overall >= 0.4) return RiskLevel.MEDIUM;
  if (overall >= 0.2) return RiskLevel.HIGH;
  return RiskLevel.CRITICAL;
}

const MIN_REQUIRED_BY_ACTION: Record<string, number> = {
  install: 50,
  execute: 25,
  read: 10,
  write_file: 70,
  delete_file: 80,
  execute_shell: 80,
  network_request: 50,
  default: 25,
};

export class TrustEvaluator extends EventEmitter {
  private readonly factors: Array<{ name: string; evaluator: FactorEvaluator }> = [
    ...DEFAULT_FACTORS,
  ];

  private readonly revokedTools = new Set<string>();
  private readonly monitorCallbacks: MonitorCallback[] = [];

  evaluate(tool: ToolMetadata): TrustScore {
    let weightedSum = 0;
    let totalWeight = 0;
    const factors: TrustFactor[] = [];

    for (const { name, evaluator } of this.factors) {
      try {
        const result = evaluator(tool);
        const clampedScore = Math.max(0, Math.min(100, result.score));
        factors.push({ name, ...result, score: clampedScore });
        weightedSum += clampedScore * result.weight;
        totalWeight += result.weight;
      } catch (err) {
        logger.warn('Trust factor evaluator threw', { name, err });
        factors.push({ name, weight: 0, score: 0, reason: 'Evaluator error' });
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    const level = scoreToLevel(score);

    logger.debug('Trust evaluated', { toolId: tool.id, score, level });
    return { score, level, factors };
  }

  addFactor(name: string, evaluator: FactorEvaluator): void {
    const idx = this.factors.findIndex((f) => f.name === name);
    if (idx >= 0) {
      this.factors[idx] = { name, evaluator };
    } else {
      this.factors.push({ name, evaluator });
    }
    logger.debug('Trust factor registered', { name });
  }

  removeFactor(name: string): boolean {
    const idx = this.factors.findIndex((f) => f.name === name);
    if (idx < 0) return false;
    this.factors.splice(idx, 1);
    return true;
  }

  getMinimumRequired(action: string): number {
    return MIN_REQUIRED_BY_ACTION[action] ?? MIN_REQUIRED_BY_ACTION['default']!;
  }

  // ─────────────────────────────────────────────────────────────────
  // 10-Stage Trust Pipeline
  // ─────────────────────────────────────────────────────────────────

  /**
   * Run the full 10-stage trust pipeline for a tool.
   * Returns a `PipelineResult` containing the canonical `TrustScore` (0–1 range)
   * defined in `src/types/index.ts`, a risk level, and an approval decision.
   *
   * Decision thresholds:
   *   overall > 0.7  → auto-approve
   *   overall < 0.4  → auto-deny
   *   otherwise      → require human approval
   */
  async evaluatePipeline(
    tool: ToolMetadata,
    options: PipelineOptions = {},
  ): Promise<PipelineResult> {
    const { allowlist = [], denylist = [], requestedBy = 'system', action = 'execute' } = options;
    const stageResults: PipelineStageResult[] = [];

    // ── Stage 1: Discovery ──────────────────────────────────────────
    const discoveryPassed = tool.source !== 'unknown';
    stageResults.push({
      stage: 1,
      name: 'discovery',
      passed: discoveryPassed,
      details: discoveryPassed
        ? `Tool discovered from source: ${tool.source}`
        : 'Tool source is unknown — provenance cannot be established',
    });
    logger.info('Trust pipeline stage 1 (discovery)', {
      toolId: tool.id,
      source: tool.source,
      passed: discoveryPassed,
    });

    // ── Stage 2: Metadata Inspection ───────────────────────────────
    const metadataIssues: string[] = [];
    if (!tool.name || tool.name.trim() === '') metadataIssues.push('name is empty');
    if (!tool.version || tool.version.trim() === '') metadataIssues.push('version is missing');
    if (!tool.author) metadataIssues.push('author is absent');
    if (!tool.publishedAt) metadataIssues.push('publishedAt is absent');
    const semverRegex = /^\d+\.\d+\.\d+/;
    if (tool.version && !semverRegex.test(tool.version)) {
      metadataIssues.push('version does not follow semver');
    }
    const metadataPassed = metadataIssues.length === 0;
    stageResults.push({
      stage: 2,
      name: 'metadata_inspection',
      passed: metadataPassed,
      details: metadataPassed
        ? 'Metadata validation passed'
        : `Metadata issues: ${metadataIssues.join(', ')}`,
    });
    logger.info('Trust pipeline stage 2 (metadata_inspection)', {
      toolId: tool.id,
      issues: metadataIssues,
      passed: metadataPassed,
    });

    // ── Stage 3: Source Validation ─────────────────────────────────
    const hasDownloads = (tool.downloadCount ?? 0) > 0;
    const hasRepo = Boolean(tool.repositoryUrl);
    const sourceValidationPassed = discoveryPassed && (hasDownloads || hasRepo);
    stageResults.push({
      stage: 3,
      name: 'source_validation',
      passed: sourceValidationPassed,
      details: sourceValidationPassed
        ? `Source validated: downloads=${tool.downloadCount ?? 0}, repo=${tool.repositoryUrl ?? 'none'}`
        : 'Source could not be fully validated (no downloads or repository URL)',
    });
    logger.info('Trust pipeline stage 3 (source_validation)', {
      toolId: tool.id,
      downloadCount: tool.downloadCount,
      repositoryUrl: tool.repositoryUrl,
      passed: sourceValidationPassed,
    });

    // ── Stage 4: Signature / Provenance ────────────────────────────
    const slsaLevel = tool.slsaLevel ?? (tool.metadata?.['slsaLevel'] as number | undefined) ?? 0;
    const sigPassed = tool.signatureValid === true;
    const provenancePassed = sigPassed && slsaLevel >= 2;
    stageResults.push({
      stage: 4,
      name: 'signature_provenance',
      passed: sigPassed,
      details: `signature=${tool.signatureValid ?? 'unchecked'}, SLSA level=${slsaLevel}`,
    });
    logger.info('Trust pipeline stage 4 (signature_provenance)', {
      toolId: tool.id,
      signatureValid: tool.signatureValid,
      slsaLevel,
      passed: sigPassed,
    });

    // ── Stage 5: Policy Evaluation ─────────────────────────────────
    const inDenylist = denylist.includes(tool.id) || denylist.includes(tool.name);
    const inAllowlist = allowlist.includes(tool.id) || allowlist.includes(tool.name);
    const policyPassed = !inDenylist;
    stageResults.push({
      stage: 5,
      name: 'policy_evaluation',
      passed: policyPassed,
      details: inDenylist
        ? `Tool "${tool.id}" is on the denylist`
        : inAllowlist
          ? `Tool "${tool.id}" is on the allowlist — policy override applied`
          : 'No explicit allowlist/denylist match',
    });
    logger.info('Trust pipeline stage 5 (policy_evaluation)', {
      toolId: tool.id,
      inAllowlist,
      inDenylist,
      passed: policyPassed,
    });

    // ── Stage 6: Risk Scoring ──────────────────────────────────────
    // Compute each breakdown dimension as a 0–1 value.

    // provenance: source type + repository presence + SLSA level
    const sourceProvenanceMap: Record<ToolMetadata['source'], number> = {
      official_registry: 1.0,
      enterprise: 0.85,
      github: 0.60,
      local: 0.40,
      unknown: 0.05,
    };
    const sourceScore = sourceProvenanceMap[tool.source] ?? 0.05;
    const slsaBonus = Math.min(slsaLevel / 4, 1.0) * 0.25; // up to 0.25 bonus for SLSA 4
    const repoBonus = hasRepo ? 0.05 : 0;
    const provenance = Math.min(sourceScore * 0.70 + slsaBonus + repoBonus, 1.0);

    // signature: cryptographic validity
    const signature =
      tool.signatureValid === true ? 1.0 : tool.signatureValid === false ? 0.0 : 0.20;

    // age: publish date recency + version stability
    let ageDateScore = 0.5; // neutral if no publishedAt
    if (tool.publishedAt) {
      const publishedMs = new Date(tool.publishedAt).getTime();
      const ageMs = Date.now() - publishedMs;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays >= 365) {
        ageDateScore = 1.0; // > 1 year old — established
      } else if (ageDays >= 90) {
        ageDateScore = 0.75;
      } else if (ageDays >= 30) {
        ageDateScore = 0.5;
      } else {
        ageDateScore = 0.25; // brand new
      }
    }
    const semverMatch = /^(\d+)\.(\d+)\./.exec(tool.version);
    let versionScore = 0.5;
    if (semverMatch) {
      const major = parseInt(semverMatch[1]!, 10);
      const minor = parseInt(semverMatch[2]!, 10);
      if (major >= 1) versionScore = 1.0;
      else if (minor >= 5) versionScore = 0.6;
      else versionScore = 0.3;
    }
    const age = (ageDateScore + versionScore) / 2;

    // downloads: community adoption
    const dlCount = tool.downloadCount ?? 0;
    let downloads: number;
    if (dlCount >= 100_000) downloads = 1.0;
    else if (dlCount >= 10_000) downloads = 0.80;
    else if (dlCount >= 1_000) downloads = 0.60;
    else if (dlCount > 0) downloads = 0.30;
    else downloads = 0.10;

    // policy: explicit organisational rules (allowlist/denylist)
    let policy: number;
    if (inDenylist) {
      policy = 0.0;
    } else if (inAllowlist) {
      policy = 1.0;
    } else {
      // Factor in known vulnerabilities
      const vulns = tool.knownVulnerabilities ?? 0;
      if (vulns === 0) policy = 0.85;
      else if (vulns <= 2) policy = 0.40;
      else policy = 0.05;
    }

    const breakdown = { provenance, signature, age, downloads, policy };

    // Weighted overall (0–1)
    const overall = Math.round(
      (provenance * 0.25 + signature * 0.25 + age * 0.15 + downloads * 0.15 + policy * 0.20) * 100,
    ) / 100;

    const riskLevel = scoreToRiskLevel(overall);

    const trustScore: CanonicalTrustScore = {
      overall,
      breakdown,
      evaluatedAt: new Date(),
    };

    stageResults.push({
      stage: 6,
      name: 'risk_scoring',
      passed: true,
      details: `overall=${overall}, riskLevel=${riskLevel}, breakdown=${JSON.stringify(breakdown)}`,
    });
    logger.info('Trust pipeline stage 6 (risk_scoring)', {
      toolId: tool.id,
      overall,
      riskLevel,
      breakdown,
    });

    // ── Stage 7: Approval Gate ─────────────────────────────────────
    // overall > 0.7  → auto-approve
    // overall < 0.4  → auto-deny
    // 0.4–0.7        → require human approval
    // Denylist always overrides to deny regardless of score.

    let approved = false;
    let requiresApproval = false;
    let denied = false;

    if (inDenylist) {
      denied = true;
      stageResults.push({
        stage: 7,
        name: 'approval_gate',
        passed: false,
        details: `Tool "${tool.id}" is on the denylist — auto-denied`,
      });
      logger.info('Trust pipeline stage 7 (approval_gate): denylist override', {
        toolId: tool.id,
      });
    } else if (inAllowlist) {
      approved = true;
      stageResults.push({
        stage: 7,
        name: 'approval_gate',
        passed: true,
        details: `Tool "${tool.id}" is on the allowlist — auto-approved`,
      });
      logger.info('Trust pipeline stage 7 (approval_gate): allowlist override', {
        toolId: tool.id,
      });
    } else if (overall > 0.7) {
      approved = true;
      stageResults.push({
        stage: 7,
        name: 'approval_gate',
        passed: true,
        details: `Score ${overall} > 0.7 — auto-approved`,
      });
      logger.info('Trust pipeline stage 7 (approval_gate): auto-approved', {
        toolId: tool.id,
        overall,
      });
    } else if (overall < 0.4) {
      denied = true;
      stageResults.push({
        stage: 7,
        name: 'approval_gate',
        passed: false,
        details: `Score ${overall} < 0.4 — auto-denied`,
      });
      logger.info('Trust pipeline stage 7 (approval_gate): auto-denied', {
        toolId: tool.id,
        overall,
      });
    } else {
      requiresApproval = true;
      // Route to approval gate for HIGH/CRITICAL risk tools
      if (riskLevel === 'high' || riskLevel === 'critical') {
        try {
          void approvalGate.request(
            tool.id,
            action,
            requestedBy,
            `Trust score ${overall} requires human review (risk: ${riskLevel})`,
            { trustScore, riskLevel },
          );
        } catch (err) {
          logger.warn('Failed to submit approval gate request', { toolId: tool.id, err });
        }
      }
      stageResults.push({
        stage: 7,
        name: 'approval_gate',
        passed: false,
        details: `Score ${overall} in [0.4, 0.7] — human approval required`,
      });
      logger.info('Trust pipeline stage 7 (approval_gate): requires approval', {
        toolId: tool.id,
        overall,
        riskLevel,
      });
    }

    // ── Stage 8: Provisioning Gate — emit trust:evaluated event ───
    const partialResult: Omit<PipelineResult, 'revoked'> & { revoked: boolean } = {
      trustScore,
      riskLevel,
      approved,
      requiresApproval,
      denied,
      revoked: false,
      stageResults,
    };
    this.emit('trust:evaluated', tool.id, partialResult);

    stageResults.push({
      stage: 8,
      name: 'provisioning_gate',
      passed: true,
      details: `trust:evaluated event emitted with overall=${overall}`,
    });
    logger.info('Trust pipeline stage 8 (provisioning_gate)', {
      toolId: tool.id,
      overall,
      approved,
      requiresApproval,
      denied,
    });

    auditLog.record(
      'trust.pipeline.evaluated',
      requestedBy,
      tool.id,
      denied ? 'failure' : 'success',
      undefined,
      { overall, riskLevel, approved, requiresApproval, breakdown },
    );

    // ── Stage 9: Runtime Monitoring Hook ──────────────────────────
    for (const cb of this.monitorCallbacks) {
      try {
        cb(tool.id, partialResult);
      } catch (err) {
        logger.warn('Monitor callback threw an error', { toolId: tool.id, err });
      }
    }
    stageResults.push({
      stage: 9,
      name: 'runtime_monitoring',
      passed: true,
      details: `${this.monitorCallbacks.length} monitor callback(s) invoked`,
    });
    logger.info('Trust pipeline stage 9 (runtime_monitoring)', {
      toolId: tool.id,
      callbackCount: this.monitorCallbacks.length,
    });

    // ── Stage 10: Revocation Path ──────────────────────────────────
    const revoked = this.revokedTools.has(tool.id);
    if (revoked) {
      approved = false;
      denied = true;
      requiresApproval = false;
    }
    stageResults.push({
      stage: 10,
      name: 'revocation',
      passed: !revoked,
      details: revoked
        ? `Tool "${tool.id}" has been revoked — denied`
        : `Tool "${tool.id}" is not revoked`,
    });
    logger.info('Trust pipeline stage 10 (revocation)', {
      toolId: tool.id,
      revoked,
    });

    const result: PipelineResult = {
      trustScore,
      riskLevel,
      approved,
      requiresApproval,
      denied,
      revoked,
      stageResults,
    };

    return result;
  }

  /**
   * Revoke a tool immediately.
   * Any subsequent `evaluatePipeline` call for this tool will be denied.
   */
  revoke(toolId: string): void {
    this.revokedTools.add(toolId);
    logger.warn('Tool revoked', { toolId });
    auditLog.record('trust.revoke', 'system', toolId, 'success');
  }

  /** Check whether a tool ID has been revoked. */
  isRevoked(toolId: string): boolean {
    return this.revokedTools.has(toolId);
  }

  /**
   * Register an anomaly-detection callback invoked at stage 9 of the pipeline.
   * The callback receives the tool ID and the pipeline result.
   */
  registerMonitor(callback: MonitorCallback): void {
    this.monitorCallbacks.push(callback);
    logger.debug('Anomaly monitor registered', { totalMonitors: this.monitorCallbacks.length });
  }
}

export const trustEvaluator = new TrustEvaluator();
