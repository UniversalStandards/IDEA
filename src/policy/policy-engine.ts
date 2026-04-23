import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import { auditLog } from '../security/audit';
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

export interface PolicyExplanation {
  allowed: boolean;
  requiresApproval: boolean;
  summary: string;
  matchedRules: Array<{
    policyId: string;
    policyName: string;
    action: string;
    reason: string;
  }>;
  reasons: string[];
}

export interface PolicyMetrics {
  totalDecisions: number;
  allowCount: number;
  denyCount: number;
  allowDenyRatio: number;
  decisionsPerSecond: number;
  lastReloadTimestamp: Date | null;
}

// ─── JSON policy pack schema ────────────────────────────────────────────────

const JsonRuleConditionsSchema = z
  .object({
    toolId: z.array(z.string()).optional(),
    actor: z.array(z.string()).optional(),
    action: z.array(z.string()).optional(),
    environment: z.array(z.string()).optional(),
  })
  .optional();

const JsonRuleSchema = z.object({
  action: z.enum(['allow', 'deny', 'require_approval', 'log']),
  reason: z.string().min(1),
  conditions: JsonRuleConditionsSchema,
});

const JsonPolicyPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
  rules: z.array(JsonRuleSchema).min(1),
});

type JsonPolicyPack = z.infer<typeof JsonPolicyPackSchema>;

function buildCondition(
  conditions: NonNullable<z.infer<typeof JsonRuleConditionsSchema>>,
): (ctx: PolicyContext) => boolean {
  const matchesField = (field: string[] | undefined, value: string): boolean =>
    !field || field.length === 0 || field.includes(value);

  return (ctx: PolicyContext) => {
    if (!matchesField(conditions.toolId, ctx.toolId)) return false;
    if (!matchesField(conditions.actor, ctx.actor)) return false;
    if (!matchesField(conditions.action, ctx.action)) return false;
    if (!matchesField(conditions.environment, ctx.environment)) return false;
    return true;
  };
}

function jsonPackToPolicy(pack: JsonPolicyPack): Policy {
  return {
    id: pack.id,
    name: pack.name,
    priority: pack.priority,
    enabled: pack.enabled,
    rules: pack.rules.map((r) => ({
      action: r.action,
      reason: r.reason,
      condition: r.conditions ? buildCondition(r.conditions) : () => true,
    })),
  };
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
  /** Track which policies were loaded from JSON files (keyed by file path) */
  private readonly jsonFilePolicies = new Map<string, string>(); // filePath → policyId
  private watcher: fs.FSWatcher | null = null;
  private lastReloadTimestamp: Date | null = null;

  // Metrics
  private totalDecisions = 0;
  private allowCount = 0;
  private denyCount = 0;
  private readonly metricsWindowMs = 60_000;
  private readonly decisionTimestamps: number[] = [];
  /** Index into decisionTimestamps for O(1) window sliding */
  private decisionWindowStart = 0;

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

  // ─── JSON pack loading ──────────────────────────────────────────────────

  /**
   * Load all *.json files from a directory as policy packs.
   * Called at startup and on hot-reload.
   */
  loadPoliciesFromDir(dir: string): void {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      logger.warn('policy-engine: could not read policies directory', { dir, err });
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      this.loadPolicyFile(filePath);
    }
  }

  private loadPolicyFile(filePath: string): void {
    const start = Date.now();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.warn('policy-engine: failed to read policy file', { filePath, err });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn('policy-engine: failed to parse policy file as JSON', { filePath, err });
      return;
    }

    const result = JsonPolicyPackSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('policy-engine: policy file failed schema validation', {
        filePath,
        errors: result.error.issues,
      });
      return;
    }

    const policy = jsonPackToPolicy(result.data);

    // Remove the old policy registered from this file (if any)
    const oldId = this.jsonFilePolicies.get(filePath);
    if (oldId !== undefined && oldId !== policy.id) {
      this.policies.delete(oldId);
    }

    this.policies.set(policy.id, policy);
    this.jsonFilePolicies.set(filePath, policy.id);
    this.lastReloadTimestamp = new Date();

    const duration = Date.now() - start;
    logger.info('policy-engine: loaded policy file', {
      filePath,
      policyId: policy.id,
      ruleCount: policy.rules.length,
      durationMs: duration,
    });
  }

  private unloadPolicyFile(filePath: string): void {
    const id = this.jsonFilePolicies.get(filePath);
    if (id !== undefined) {
      this.policies.delete(id);
      this.jsonFilePolicies.delete(filePath);
      logger.info('policy-engine: unloaded policy file', { filePath, policyId: id });
    }
  }

  /**
   * Watch a directory for JSON policy file changes and hot-reload.
   * Returns the watcher so callers can close it.
   */
  watchPoliciesDir(dir: string): fs.FSWatcher {
    if (this.watcher !== null) {
      this.watcher.close();
    }

    this.watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename === null || !filename.endsWith('.json')) return;

      const filePath = path.join(dir, filename);
      logger.info('policy-engine: detected file change', { eventType, filename });

      if (eventType === 'rename') {
        // Could be delete or create — try loading, fall back to unload
        if (fs.existsSync(filePath)) {
          this.loadPolicyFile(filePath);
        } else {
          this.unloadPolicyFile(filePath);
        }
      } else if (eventType === 'change') {
        this.loadPolicyFile(filePath);
      }
    });
    this.watcher.on('error', (err) => {
      logger.error('policy-engine: watcher error', { dir, err });
    });

    logger.info('policy-engine: watching policies directory', { dir });
    return this.watcher;
  }

  stopWatching(): void {
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Core API ────────────────────────────────────────────────────────────

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

    // Update metrics
    this.totalDecisions += 1;
    if (allowed) {
      this.allowCount += 1;
    } else {
      this.denyCount += 1;
    }
    const now = Date.now();
    this.decisionTimestamps.push(now);

    auditLog.record(
      `policy.evaluate:${context.action}`,
      context.actor,
      context.toolId,
      allowed ? 'success' : 'failure',
      undefined,
      { decision, environment: context.environment },
    );

    logger.debug('Policy evaluated', { toolId: context.toolId, action: context.action, allowed });
    return decision;
  }

  /**
   * Returns a human-readable explanation of why a decision was reached.
   */
  explainDecision(context: PolicyContext): PolicyExplanation {
    const sorted = Array.from(this.policies.values())
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    const reasons: string[] = [];
    const matchedRules: PolicyExplanation['matchedRules'] = [];
    let allowed = true;
    let requiresApproval = false;
    let explicitAllow = false;
    let explicitDeny = false;

    for (const policy of sorted) {
      for (const rule of policy.rules) {
        let matched = false;
        try {
          matched = rule.condition(context);
        } catch {
          continue;
        }

        if (!matched) continue;

        matchedRules.push({
          policyId: policy.id,
          policyName: policy.name,
          action: rule.action,
          reason: rule.reason,
        });

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

    const outcomeLabel = allowed
      ? requiresApproval
        ? 'allowed (pending approval)'
        : 'allowed'
      : 'denied';

    const policyCount = new Set(matchedRules.map((r) => r.policyId)).size;
    const policyWord = policyCount === 1 ? 'policy' : 'policies';
    const summary = matchedRules.length === 0
      ? `Request for tool '${context.toolId}' by actor '${context.actor}' was ${outcomeLabel} — no rules matched (default deny).`
      : `Request for tool '${context.toolId}' by actor '${context.actor}' was ${outcomeLabel}. ` +
        `${String(matchedRules.length)} rule(s) matched across ${String(policyCount)} ${policyWord}.`;

    return { allowed, requiresApproval, summary, matchedRules, reasons };
  }

  /** Returns all currently loaded policies (sorted by descending priority). */
  getPolicies(): Policy[] {
    return Array.from(this.policies.values()).sort((a, b) => b.priority - a.priority);
  }

  listPolicies(): Policy[] {
    return this.getPolicies();
  }

  updatePolicy(id: string, updates: Partial<Omit<Policy, 'id'>>): boolean {
    const existing = this.policies.get(id);
    if (!existing) return false;
    this.policies.set(id, { ...existing, ...updates });
    return true;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  getMetrics(): PolicyMetrics {
    const cutoff = Date.now() - this.metricsWindowMs;
    // Advance start index past stale timestamps (O(1) amortised, no array mutation)
    while (
      this.decisionWindowStart < this.decisionTimestamps.length &&
      (this.decisionTimestamps[this.decisionWindowStart] ?? 0) < cutoff
    ) {
      this.decisionWindowStart += 1;
    }
    const windowCount = this.decisionTimestamps.length - this.decisionWindowStart;
    const decisionsPerSecond = windowCount / (this.metricsWindowMs / 1000);
    const allowDenyRatio =
      this.denyCount === 0
        ? this.allowCount > 0
          ? Infinity
          : 1
        : this.allowCount / this.denyCount;

    return {
      totalDecisions: this.totalDecisions,
      allowCount: this.allowCount,
      denyCount: this.denyCount,
      allowDenyRatio,
      decisionsPerSecond,
      lastReloadTimestamp: this.lastReloadTimestamp,
    };
  }
}

export const policyEngine = new PolicyEngine();
