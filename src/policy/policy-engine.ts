import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { auditLogger } from '../security/audit';
import { config } from '../config';

const logger = createLogger('policy-engine');

export interface PolicyRule {
  condition: (ctx: PolicyContext) => boolean;
  action: 'allow' | 'deny' | 'require_approval' | 'log';
  reason: string;
}

export interface Policy {
  id: string;
  name: string;
  rules: PolicyRule[];
  priority: number;
  enabled: boolean;
}

export interface PolicyContext {
  toolId: string;
  actor: string;
  action: string;
  environment: string;
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
}

const HIGH_RISK_ACTIONS = new Set([
  'install',
  'uninstall',
  'execute_shell',
  'write_file',
  'delete_file',
  'network_request',
  'modify_config',
  'elevate_privilege',
]);

const DEFAULT_POLICIES: Policy[] = [
  {
    id: 'default-deny-unknown',
    name: 'Deny Unknown Tools',
    priority: 100,
    enabled: true,
    rules: [
      {
        condition: (ctx) =>
          !ctx.toolId || ctx.toolId === 'unknown' || ctx.toolId.trim() === '',
        action: 'deny',
        reason: 'Unknown or unidentified tools are not permitted',
      },
    ],
  },
  {
    id: 'default-high-risk-approval',
    name: 'Require Approval for High-Risk Actions',
    priority: 90,
    enabled: true,
    rules: [
      {
        condition: (ctx) => HIGH_RISK_ACTIONS.has(ctx.action),
        action: 'require_approval',
        reason: 'High-risk action requires explicit human approval',
      },
    ],
  },
  {
    id: 'default-allow-standard',
    name: 'Allow Standard Tool Execution',
    priority: 10,
    enabled: true,
    rules: [
      {
        condition: (ctx) =>
          ctx.toolId.length > 0 &&
          !HIGH_RISK_ACTIONS.has(ctx.action),
        action: 'allow',
        reason: 'Standard tool execution is permitted',
      },
    ],
  },
];

export class PolicyEngine {
  private readonly policies = new Map<string, Policy>();

  constructor() {
    let requireApproval = true;
    try {
      requireApproval = config.REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS;
    } catch {
      requireApproval = process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'] !== 'false';
    }

    for (const p of DEFAULT_POLICIES) {
      const policy = { ...p };
      if (policy.id === 'default-high-risk-approval') {
        policy.enabled = requireApproval;
      }
      this.policies.set(policy.id, policy);
    }
  }

  addPolicy(policy: Policy): void {
    this.policies.set(policy.id, policy);
    logger.info('Policy added', { id: policy.id, name: policy.name });
  }

  removePolicy(id: string): boolean {
    const existed = this.policies.has(id);
    this.policies.delete(id);
    if (existed) logger.info('Policy removed', { id });
    return existed;
  }

  evaluate(context: PolicyContext): PolicyDecision {
    const sorted = Array.from(this.policies.values())
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    const reasons: string[] = [];
    let allowed = true;
    let requiresApproval = false;
    let explicitAllow = false;
    let explicitDeny = false;

    for (const policy of sorted) {
      for (const rule of policy.rules) {
        let matched = false;
        try {
          matched = rule.condition(context);
        } catch (err) {
          logger.warn('Policy rule condition threw an error', {
            policyId: policy.id,
            err,
          });
          continue;
        }

        if (!matched) continue;

        switch (rule.action) {
          case 'deny':
            explicitDeny = true;
            reasons.push(`[DENY] ${rule.reason} (policy: ${policy.name})`);
            break;
          case 'allow':
            explicitAllow = true;
            reasons.push(`[ALLOW] ${rule.reason} (policy: ${policy.name})`);
            break;
          case 'require_approval':
            requiresApproval = true;
            reasons.push(`[APPROVAL_REQUIRED] ${rule.reason} (policy: ${policy.name})`);
            break;
          case 'log':
            reasons.push(`[LOG] ${rule.reason} (policy: ${policy.name})`);
            break;
        }
      }
    }

    if (explicitDeny) {
      allowed = false;
      requiresApproval = false;
    } else if (explicitAllow) {
      allowed = true;
    } else {
      // Default: deny-by-default if no explicit allow
      allowed = false;
      reasons.push('[DENY] No explicit allow policy matched — default deny');
    }

    const decision: PolicyDecision = { allowed, requiresApproval, reasons };

    auditLogger.log({
      actor: context.actor,
      action: `policy.evaluate:${context.action}`,
      resource: context.toolId,
      outcome: allowed ? 'success' : 'denied',
      metadata: { decision, environment: context.environment },
    });

    logger.debug('Policy evaluated', { toolId: context.toolId, action: context.action, allowed });
    return decision;
  }

  listPolicies(): Policy[] {
    return Array.from(this.policies.values()).sort((a, b) => b.priority - a.priority);
  }

  updatePolicy(id: string, updates: Partial<Omit<Policy, 'id'>>): boolean {
    const existing = this.policies.get(id);
    if (!existing) return false;
    this.policies.set(id, { ...existing, ...updates });
    return true;
  }
}

export const policyEngine = new PolicyEngine();
