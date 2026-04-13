import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../observability/logger';
import { auditLogger } from '../security/audit';
import { metrics } from '../observability/metrics';
import { config } from '../config';

const logger = createLogger('policy-engine');

export interface PolicyRule {
  condition: (ctx: PolicyContext) => boolean;
  action: 'allow' | 'deny' | 'require_approval' | 'log';
  reason: string;
  sourceId?: string;
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
  reason: string;
  matchedRules: string[];
  decision: PolicyDecision;
}

// ── Policy Pack (JSON schema) ────────────────────────────────────────────────

interface PackConditionField {
  pattern?: string;
  eq?: string;
  gte?: number;
  contains?: string;
}

interface PackConditions {
  action?: PackConditionField;
  environment?: PackConditionField;
  riskLevel?: PackConditionField;
  capabilities?: PackConditionField;
}

interface PackRule {
  id: string;
  description: string;
  conditions: PackConditions;
  effect: 'allow' | 'deny' | 'require_approval';
  severity: string;
  rateLimit?: { requests: number; windowSeconds: number };
}

interface PolicyPack {
  name: string;
  version: string;
  description?: string;
  rules: PackRule[];
}

function isValidPackRule(r: unknown): r is PackRule {
  if (typeof r !== 'object' || r === null) return false;
  const rule = r as Record<string, unknown>;
  return (
    typeof rule['id'] === 'string' &&
    typeof rule['description'] === 'string' &&
    typeof rule['conditions'] === 'object' &&
    rule['conditions'] !== null &&
    (rule['effect'] === 'allow' ||
      rule['effect'] === 'deny' ||
      rule['effect'] === 'require_approval')
  );
}

function isValidPolicyPack(data: unknown): data is PolicyPack {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d['name'] === 'string' &&
    Array.isArray(d['rules']) &&
    (d['rules'] as unknown[]).every(isValidPackRule)
  );
}

function buildConditionFn(conditions: PackConditions): (ctx: PolicyContext) => boolean {
  return (ctx: PolicyContext): boolean => {
    if (conditions.action?.pattern !== undefined) {
      const re = new RegExp(conditions.action.pattern);
      if (!re.test(ctx.action)) return false;
    }
    if (conditions.environment?.eq !== undefined) {
      if (ctx.environment !== conditions.environment.eq) return false;
    }
    if (conditions.riskLevel?.gte !== undefined) {
      const level = ctx.metadata?.['riskLevel'];
      if (typeof level !== 'number' || level < conditions.riskLevel.gte) return false;
    }
    if (conditions.capabilities?.contains !== undefined) {
      const caps = ctx.metadata?.['capabilities'];
      if (!Array.isArray(caps) || !caps.includes(conditions.capabilities.contains)) return false;
    }
    return true;
  };
}

function packRuleToPolicy(packName: string, rule: PackRule, index: number): Policy {
  return {
    id: `pack:${packName}:rule:${rule.id}`,
    name: `[${packName}] ${rule.description}`,
    priority: 50 - index,
    enabled: true,
    rules: [
      {
        condition: buildConditionFn(rule.conditions),
        action: rule.effect,
        reason: rule.description,
        sourceId: rule.id,
      },
    ],
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
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  // ── Policy Pack Loading ──────────────────────────────────────────────────

  async loadPoliciesFromDir(policiesDir?: string): Promise<void> {
    const dir = policiesDir ?? path.resolve(process.cwd(), 'policies');

    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn('policies/ directory not found — skipping policy pack loading', { dir });
        return;
      }
      throw err;
    }

    // Remove previously loaded pack policies before reloading
    for (const id of Array.from(this.policies.keys())) {
      if (id.startsWith('pack:')) {
        this.policies.delete(id);
      }
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      let raw: string;
      try {
        raw = await fsp.readFile(filePath, 'utf8');
      } catch (err) {
        logger.warn('Failed to read policy pack file', { file, err });
        continue;
      }

      let data: unknown;
      try {
        data = JSON.parse(raw) as unknown;
      } catch (err) {
        logger.warn('Failed to parse policy pack JSON', { file, err });
        continue;
      }

      if (!isValidPolicyPack(data)) {
        logger.warn('Policy pack failed validation (missing name or rules array)', { file });
        continue;
      }

      let idx = 0;
      for (const rule of data.rules) {
        const policy = packRuleToPolicy(data.name, rule, idx);
        this.policies.set(policy.id, policy);
        idx++;
      }
      logger.info('Loaded policy pack', {
        file,
        pack: data.name,
        ruleCount: data.rules.length,
      });
    }
  }

  // ── Hot-Reload Watcher ───────────────────────────────────────────────────

  startWatcher(policiesDir?: string): void {
    if (process.env['NODE_ENV'] === 'test') return;

    const dir = policiesDir ?? path.resolve(process.cwd(), 'policies');

    // Silently skip if directory does not exist
    if (!fs.existsSync(dir)) {
      logger.warn('Cannot start policy watcher — policies/ directory does not exist', { dir });
      return;
    }

    if (this.watcher) return; // already watching

    this.watcher = fs.watch(dir, { persistent: false }, () => {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.loadPoliciesFromDir(dir).catch((err: unknown) => {
          logger.error('Hot-reload of policy packs failed', { err });
        });
      }, 500);
    });

    this.watcher.on('error', (err: unknown) => {
      logger.error('Policy watcher error', { err });
    });

    logger.info('Policy hot-reload watcher started', { dir });
  }

  stopWatcher(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('Policy hot-reload watcher stopped');
    }
  }

  // ── Core Policy Management ───────────────────────────────────────────────

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

  // ── Internal Evaluation Core ─────────────────────────────────────────────

  private evaluateCore(context: PolicyContext): {
    decision: PolicyDecision;
    matchedRuleIds: string[];
  } {
    const sorted = Array.from(this.policies.values())
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    const reasons: string[] = [];
    const matchedRuleIds: string[] = [];
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

        const ruleId = rule.sourceId ?? policy.id;
        matchedRuleIds.push(ruleId);

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

    return { decision: { allowed, requiresApproval, reasons }, matchedRuleIds };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  evaluate(context: PolicyContext): PolicyDecision {
    const { decision, matchedRuleIds: _matchedRuleIds } = this.evaluateCore(context);
    const { allowed } = decision;

    metrics.increment('policy_decisions_total', { outcome: allowed ? 'allow' : 'deny' });

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

  explainDecision(context: PolicyContext): PolicyExplanation {
    const { decision, matchedRuleIds } = this.evaluateCore(context);
    const { allowed } = decision;

    let reason: string;
    if (!allowed) {
      const denyEntry = decision.reasons.find((r) => r.startsWith('[DENY]'));
      if (denyEntry !== undefined) {
        // Extract text after "[DENY] " for the human-readable reason
        reason = denyEntry.replace(/^\[DENY\]\s*/, '');
      } else {
        reason = 'Action denied by policy evaluation';
      }
    } else if (decision.requiresApproval) {
      reason = 'Action requires human approval before proceeding';
    } else {
      const allowEntry = decision.reasons.find((r) => r.startsWith('[ALLOW]'));
      if (allowEntry !== undefined) {
        reason = allowEntry.replace(/^\[ALLOW\]\s*/, '');
      } else {
        reason = 'Action permitted by policy evaluation';
      }
    }

    return { allowed, reason, matchedRules: matchedRuleIds, decision };
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
