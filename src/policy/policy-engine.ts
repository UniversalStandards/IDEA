import { createLogger } from '../observability/logger';
import { config } from '../config';
import path from 'path';
import { RbacEngine, type RoleDefinition } from './rbac/RbacEngine';
import { AbacEngine, PolicyStore, type AbacRequest } from './abac/AbacEngine';
import { CsaTrustFramework, CsaTrustLevel } from './csa/CsaTrustFramework';
import { TrustLevelEvaluator, type TrustEvaluationInput } from './csa/TrustLevelEvaluator';
import { RateLimiter } from './limits/RateLimiter';
import { QuotaManager } from './limits/QuotaManager';
import { PolicyAuditLog } from './audit/PolicyAuditLog';

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

export interface GovernanceContext {
  orgId: string;
  userId: string;
  action: string;
  resource: {
    id: string;
    type: string;
    attributes?: Record<string, unknown>;
  };
  subjectAttributes?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  request?: Record<string, unknown>;
  roleHint?: string;
  tokenUsage?: number;
  computeSeconds?: number;
}

export interface GovernanceDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
  csaLevel: CsaTrustLevel;
  csaLevelName: string;
  permissions: string[];
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
        condition: (ctx) => !ctx.toolId || ctx.toolId === 'unknown' || ctx.toolId.trim() === '',
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
        condition: (ctx) => ctx.toolId.length > 0 && !HIGH_RISK_ACTIONS.has(ctx.action),
        action: 'allow',
        reason: 'Standard tool execution is permitted',
      },
    ],
  },
];

const DEFAULT_RBAC_ROLES: RoleDefinition[] = [
  { name: 'intern', permissions: ['read:*'], inherits: [] },
  { name: 'assistant', permissions: ['tool:execute:approved'], inherits: ['intern'] },
  { name: 'collaborator', permissions: ['workflow:cross-tool'], inherits: ['assistant'] },
  { name: 'expert', permissions: ['tool:execute:*', 'plan:self-directed'], inherits: ['collaborator'] },
  { name: 'principal', permissions: ['delegate:agent', 'authority:org-wide'], inherits: ['expert'] },
];

export class PolicyEngine {
  private readonly policies = new Map<string, Policy>();

  private readonly rbacEngine: RbacEngine;
  private readonly abacEngine: AbacEngine;
  private readonly csaFramework: CsaTrustFramework;
  private readonly trustLevelEvaluator: TrustLevelEvaluator;
  private readonly rateLimiter: RateLimiter;
  private readonly quotaManager: QuotaManager;
  private readonly policyAuditLog: PolicyAuditLog;

  constructor(policyBaseDir?: string) {
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

    this.rbacEngine = new RbacEngine(DEFAULT_RBAC_ROLES);
    this.abacEngine = new AbacEngine(new PolicyStore(policyBaseDir));
    this.csaFramework = new CsaTrustFramework();
    this.trustLevelEvaluator = new TrustLevelEvaluator(this.csaFramework);
    this.rateLimiter = new RateLimiter();
    this.quotaManager = new QuotaManager();
    const auditPath = policyBaseDir
      ? path.join(policyBaseDir, 'policy-audit.jsonl')
      : undefined;
    this.policyAuditLog = new PolicyAuditLog(auditPath);
  }

  getRbacEngine(): RbacEngine {
    return this.rbacEngine;
  }

  getAbacEngine(): AbacEngine {
    return this.abacEngine;
  }

  getQuotaManager(): QuotaManager {
    return this.quotaManager;
  }

  getPolicyAuditLog(): PolicyAuditLog {
    return this.policyAuditLog;
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
      allowed = false;
      reasons.push('[DENY] No explicit allow policy matched — default deny');
    }

    const decision: PolicyDecision = { allowed, requiresApproval, reasons };

    this.policyAuditLog.append({
      orgId: String(context.metadata?.['orgId'] ?? 'global'),
      actor: context.actor,
      action: `policy.evaluate:${context.action}`,
      resource: context.toolId,
      decision: allowed ? 'allow' : requiresApproval ? 'require_approval' : 'deny',
      reason: reasons.join(' | '),
      metadata: { environment: context.environment },
    });

    logger.debug('Policy evaluated', { toolId: context.toolId, action: context.action, allowed });
    return decision;
  }

  async evaluateGovernance(input: GovernanceContext): Promise<GovernanceDecision> {
    const permissions = this.rbacEngine.resolvePermissions(input.orgId, input.userId);
    const assignedRoles = this.rbacEngine.getUserRoles(input.orgId, input.userId);

    if (assignedRoles.length === 0 && !input.roleHint) {
      const safeUserId = input.userId.replace(/[\r\n\t]/gu, '_');
      const safeOrgId = input.orgId.replace(/[\r\n\t]/gu, '_');
      return {
        allowed: false,
        requiresApproval: false,
        reasons: [`No RBAC role assignment found for user '${safeUserId}' in org '${safeOrgId}'`],
        csaLevel: CsaTrustLevel.Intern,
        csaLevelName: this.csaFramework.getLevelName(CsaTrustLevel.Intern),
        permissions: [],
      };
    }

    const roleHint = input.roleHint ?? assignedRoles[0] ?? 'intern';
    const trustInput: TrustEvaluationInput = {
      role: roleHint,
      permissions: Array.from(permissions),
      context: {
        crossToolWorkflowCount: Number(input.request?.['crossToolWorkflowCount'] ?? 0),
        sensitiveActionApprovalRate: Number(input.request?.['sensitiveActionApprovalRate'] ?? 0),
        completedSecurityTraining: Boolean(input.subjectAttributes?.['completedSecurityTraining']),
        delegationAllowed: permissions.has('delegate:agent'),
        orgApprovalGranted: Boolean(input.subjectAttributes?.['orgApprovalGranted']),
      },
      history: {
        incidentsLast90Days: Number(input.subjectAttributes?.['incidentsLast90Days'] ?? 0),
        successfulRunsLast30Days: Number(input.subjectAttributes?.['successfulRunsLast30Days'] ?? 0),
      },
    };

    const trustResult = this.trustLevelEvaluator.evaluate(trustInput);

    const limit = await this.rateLimiter.check(
      { orgId: input.orgId, userId: input.userId, role: roleHint },
      { windowMs: config.RATE_LIMIT_WINDOW_MS, maxRequests: config.RATE_LIMIT_MAX_REQUESTS },
    );

    if (!limit.allowed) {
      return {
        allowed: false,
        requiresApproval: false,
        reasons: ['Rate limit exceeded'],
        csaLevel: trustResult.level,
        csaLevelName: trustResult.levelName,
        permissions: Array.from(permissions),
      };
    }

    const quotaDecision = this.quotaManager.consume(input.orgId, {
      calls: 1,
      tokens: input.tokenUsage ?? 0,
      computeSeconds: input.computeSeconds ?? 0,
    });

    if (!quotaDecision.allowed) {
      return {
        allowed: false,
        requiresApproval: false,
        reasons: [quotaDecision.reason],
        csaLevel: trustResult.level,
        csaLevelName: trustResult.levelName,
        permissions: Array.from(permissions),
      };
    }

    const abacRequest: AbacRequest = {
      orgId: input.orgId,
      action: input.action,
      resource: {
        id: input.resource.id,
        type: input.resource.type,
        attributes: input.resource.attributes ?? {},
      },
      subject: {
        id: input.userId,
        roles: assignedRoles,
        attributes: input.subjectAttributes ?? {},
      },
      environment: input.environment ?? {},
      request: input.request ?? {},
    };

    const abacDecision = this.abacEngine.evaluate(abacRequest);
    const csaRequiredLevel = HIGH_RISK_ACTIONS.has(input.action) ? CsaTrustLevel.Collaborator : CsaTrustLevel.Assistant;
    const hasCsaAccess = this.csaFramework.enforceMinimumLevel(trustResult.level, csaRequiredLevel);

    const reasons: string[] = [...trustResult.rationale, abacDecision.reason];
    const requiresApproval = HIGH_RISK_ACTIONS.has(input.action) && trustResult.level < CsaTrustLevel.Expert;

    const allowed = abacDecision.allowed && hasCsaAccess;

    this.policyAuditLog.append({
      orgId: input.orgId,
      actor: input.userId,
      action: `policy.governance:${input.action}`,
      resource: `${input.resource.type}:${input.resource.id}`,
      decision: allowed ? 'allow' : requiresApproval ? 'require_approval' : 'deny',
      reason: reasons.join(' | '),
      metadata: {
        permissions: Array.from(permissions),
        matchedRuleIds: abacDecision.matchedRuleIds,
      },
    });

    return {
      allowed,
      requiresApproval,
      reasons,
      csaLevel: trustResult.level,
      csaLevelName: trustResult.levelName,
      permissions: Array.from(permissions),
    };
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
