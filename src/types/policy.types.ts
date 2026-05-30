export interface PolicyRule {
  readonly id: string;
  readonly orgId: string;
  readonly effect: 'allow' | 'deny';
  readonly action: string;
  readonly resource: string;
  readonly conditions?: Record<string, unknown>;
}

export interface RbacRole {
  readonly id: string;
  readonly name: string;
  readonly permissions: string[];
  readonly inherits: string[];
}

export interface AbacPolicy {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly rules: PolicyRule[];
}

export interface CsaTrustLevel {
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly name: string;
  readonly permissions: string[];
}

export interface QuotaConfig {
  readonly orgId: string;
  readonly maxRequestsPerMinute: number;
  readonly maxRequestsPerDay: number;
  readonly maxConcurrentWorkflows: number;
}

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly burst?: number;
}
