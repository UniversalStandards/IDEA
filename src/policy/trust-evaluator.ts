import { createLogger } from '../observability/logger';

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

type FactorEvaluator = (tool: ToolMetadata) => Omit<TrustFactor, 'name'>;

const DEFAULT_FACTORS: Array<{ name: string; evaluator: FactorEvaluator }> = [
  {
    name: 'source',
    evaluator: (tool): Omit<TrustFactor, 'name'> => {
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
    evaluator: (tool): Omit<TrustFactor, 'name'> => {
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
    evaluator: (tool): Omit<TrustFactor, 'name'> => {
      const semverRegex = /^(\d+)\.(\d+)\.(\d+)/;
      const match = semverRegex.exec(tool.version);
      if (!match) return { weight: 0.15, score: 10, reason: 'Non-semver version string' };
      const major = parseInt(match[1] ?? '0', 10);
      if (major >= 1) return { weight: 0.15, score: 90, reason: 'Stable major version >= 1' };
      if (major === 0) {
        const minor = parseInt(match[2] ?? '0', 10);
        if (minor >= 5) return { weight: 0.15, score: 60, reason: 'Pre-1.0 but minor >= 5' };
        return { weight: 0.15, score: 30, reason: 'Pre-1.0 early-stage version' };
      }
      return { weight: 0.15, score: 10, reason: 'Unrecognized version pattern' };
    },
  },
  {
    name: 'popularity',
    evaluator: (tool): Omit<TrustFactor, 'name'> => {
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
    evaluator: (tool): Omit<TrustFactor, 'name'> => {
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

export class TrustEvaluator {
  private readonly factors: Array<{ name: string; evaluator: FactorEvaluator }> = [
    ...DEFAULT_FACTORS,
  ];

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
    return MIN_REQUIRED_BY_ACTION[action] ?? MIN_REQUIRED_BY_ACTION['default'] ?? 25;
  }
}

export const trustEvaluator = new TrustEvaluator();
