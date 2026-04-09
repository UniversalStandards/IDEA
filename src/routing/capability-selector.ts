import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { RegisteredTool } from '../provisioning/runtime-registrar';
import { NormalizedRequest } from '../normalization/request-normalizer';

const logger = createLogger('capability-selector');

export interface SelectionResult {
  tool: RegisteredTool;
  score: number;
  reasons: string[];
}

interface ToolStats {
  totalCalls: number;
  successCalls: number;
  totalLatencyMs: number;
}

const SOURCE_TRUST: Record<string, number> = {
  official: 1.0,
  enterprise: 0.85,
  github: 0.7,
  local: 0.6,
  unknown: 0.3,
};

export class CapabilitySelector {
  private readonly stats = new Map<string, ToolStats>();

  select(
    request: NormalizedRequest,
    availableTools: RegisteredTool[],
  ): SelectionResult | null {
    if (availableTools.length === 0) return null;

    const candidates = availableTools.filter(
      (t) => t.status === 'registered' || t.status === 'running',
    );
    if (candidates.length === 0) return null;

    const scored = candidates
      .map((t) => this.scoreTool(t, request))
      .filter((r): r is SelectionResult => r !== null)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    const best = scored[0];
    logger.debug('Capability selected', {
      requestId: request.id,
      toolId: best.tool.tool.id,
      score: best.score,
      reasons: best.reasons,
    });

    metrics.increment('capability_selections_total', { toolId: best.tool.tool.id });
    return best;
  }

  private scoreTool(
    registered: RegisteredTool,
    request: NormalizedRequest,
  ): SelectionResult | null {
    const tool = registered.tool;
    let score = 0;
    const reasons: string[] = [];

    // 1. Name match
    const methodLower = request.method.toLowerCase();
    const nameLower = tool.name.toLowerCase();
    if (nameLower === methodLower) {
      score += 40;
      reasons.push('exact name match');
    } else if (nameLower.includes(methodLower) || methodLower.includes(nameLower)) {
      score += 20;
      reasons.push('partial name match');
    }

    // 2. Capability/tag match against request params
    const queryTerms = this.extractQueryTerms(request);
    const capMatches = tool.capabilities.filter((c) =>
      queryTerms.some((t) => c.toLowerCase().includes(t) || t.includes(c.toLowerCase())),
    );
    if (capMatches.length > 0) {
      score += Math.min(25, capMatches.length * 8);
      reasons.push(`capability match: ${capMatches.join(', ')}`);
    }

    const tagMatches = tool.tags.filter((tag) =>
      queryTerms.some((t) => tag.toLowerCase().includes(t) || t.includes(tag.toLowerCase())),
    );
    if (tagMatches.length > 0) {
      score += Math.min(15, tagMatches.length * 5);
      reasons.push(`tag match: ${tagMatches.join(', ')}`);
    }

    // 3. Trust score from source
    const trustScore = SOURCE_TRUST[tool.source] ?? 0.3;
    score += trustScore * 10;
    reasons.push(`source trust: ${tool.source} (${trustScore})`);

    // 4. Historical success rate
    const toolStats = this.stats.get(tool.id);
    if (toolStats && toolStats.totalCalls > 0) {
      const successRate = toolStats.successCalls / toolStats.totalCalls;
      score += successRate * 15;
      const avgLatency = toolStats.totalLatencyMs / toolStats.totalCalls;
      // Prefer lower latency (subtract up to 5 points for > 2000ms avg latency)
      const latencyPenalty = Math.min(5, avgLatency / 400);
      score -= latencyPenalty;
      reasons.push(`history: ${(successRate * 100).toFixed(0)}% success, ${avgLatency.toFixed(0)}ms avg`);
    } else {
      // No history — neutral bonus to give new tools a chance
      score += 5;
      reasons.push('no history yet');
    }

    // 5. Local-vs-remote preference
    if (tool.source === 'local') {
      score += 5;
      reasons.push('local preference');
    }

    // 6. Tool status
    if (registered.status === 'running') {
      score += 3;
      reasons.push('already running');
    } else if (registered.status === 'error') {
      score -= 20;
      reasons.push('error status penalty');
    }

    // 7. Verified tools get a bonus
    if (tool.verified) {
      score += 5;
      reasons.push('verified');
    }

    return { tool: registered, score, reasons };
  }

  private extractQueryTerms(request: NormalizedRequest): string[] {
    const terms: string[] = [];

    const method = request.method.toLowerCase().replace(/[:/]/g, ' ');
    terms.push(...method.split(/\s+/).filter(Boolean));

    const toolId = request.params['toolId'];
    if (typeof toolId === 'string') {
      terms.push(...toolId.toLowerCase().split(/[-_./]/));
    }

    const action = request.params['action'];
    if (typeof action === 'string') {
      terms.push(action.toLowerCase());
    }

    const query = request.params['_query'] ?? request.params['query'];
    if (typeof query === 'string') {
      terms.push(...query.toLowerCase().split(/\s+/).filter(Boolean));
    }

    return [...new Set(terms)];
  }

  recordOutcome(toolId: string, success: boolean, latencyMs: number): void {
    const existing = this.stats.get(toolId) ?? {
      totalCalls: 0,
      successCalls: 0,
      totalLatencyMs: 0,
    };

    existing.totalCalls += 1;
    if (success) existing.successCalls += 1;
    existing.totalLatencyMs += latencyMs;

    this.stats.set(toolId, existing);

    metrics.increment('capability_outcomes_total', {
      toolId,
      success: String(success),
    });
    metrics.histogram('capability_latency_ms', latencyMs, { toolId });

    logger.debug('Outcome recorded', { toolId, success, latencyMs });
  }
}

export const capabilitySelector = new CapabilitySelector();
