/**
 * Telemetry Layer — Usage-Driven Self-Optimization
 *
 * Feeds routing/ and provisioning/ decisions: which capabilities to
 * pre-warm, which adapters are trending toward deprecation, and where
 * latency budgets are being violated. NEW — closes the gap between IDEA's
 * existing observability/ (raw logs/metrics) and actionable optimization.
 */

export interface CapabilityUsageSample {
  capabilityId: string;
  latencyMs: number;
  success: boolean;
  timestamp: string;
  tenantId?: string;
}

export interface OptimizationSignal {
  capabilityId: string;
  suggestion: 'pre_warm' | 'cache_aggressively' | 'rate_limit_tighten' | 'deprecate_candidate';
  confidence: number;
  basedOnSamples: number;
}

export interface HealthSnapshot {
  capabilityId: string;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
  windowMinutes: number;
}
