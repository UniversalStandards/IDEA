import fs from 'fs';
import path from 'path';
import { z } from 'zod';

type ScalarValue = string | number | boolean | null;
const MAX_YAML_NESTING_DEPTH = 10;
const MAX_POLICY_FILE_SIZE_BYTES = 1_000_000;

const ConditionSchema: z.ZodType<
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';
      path: string;
      value?: unknown;
    }
> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1) }),
    z.object({ any: z.array(ConditionSchema).min(1) }),
    z.object({ not: ConditionSchema }),
    z.object({
      op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists']),
      path: z.string().min(1),
      value: z.unknown().optional(),
    }),
  ]),
);

export type Condition = z.infer<typeof ConditionSchema>;

export const AbacRuleSchema = z.object({
  id: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  actions: z.array(z.string().min(1)).default(['*']),
  resources: z.array(z.string().min(1)).default(['*']),
  condition: ConditionSchema.optional(),
  reason: z.string().default('Policy rule matched'),
});

export const OrgPolicySchema = z.object({
  version: z.string().default('1'),
  defaultEffect: z.enum(['allow', 'deny']).default('deny'),
  rules: z.array(AbacRuleSchema).default([]),
});

export type AbacRule = z.infer<typeof AbacRuleSchema>;
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

export const AbacRequestSchema = z.object({
  orgId: z.string().min(1),
  action: z.string().min(1),
  resource: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    attributes: z.record(z.unknown()).default({}),
  }),
  subject: z.object({
    id: z.string().min(1),
    roles: z.array(z.string().min(1)).default([]),
    attributes: z.record(z.unknown()).default({}),
  }),
  environment: z.record(z.unknown()).default({}),
  request: z.record(z.unknown()).default({}),
});

export type AbacRequest = z.infer<typeof AbacRequestSchema>;

export interface AbacDecision {
  allowed: boolean;
  reason: string;
  matchedRuleIds: string[];
}

function getByPath(value: unknown, pointer: string): unknown {
  const keys = pointer.split('.').filter((segment) => segment.trim().length > 0);
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseScalar(value: string): ScalarValue {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSimpleYaml(raw: string): unknown {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

  let index = 0;

  const parseBlock = (indent: number, depth: number): unknown => {
    if (depth > MAX_YAML_NESTING_DEPTH) {
      throw new Error(`YAML policy exceeds maximum nesting depth (${MAX_YAML_NESTING_DEPTH})`);
    }

    if (index >= lines.length) return {};

    const currentLine = lines[index];
    if (!currentLine) return {};
    const currentIndent = currentLine.match(/^\s*/u)?.[0].length ?? 0;
    if (currentIndent < indent) return {};

    const isArray = currentLine.trimStart().startsWith('- ');

    if (isArray) {
      const result: unknown[] = [];
      while (index < lines.length) {
        const line = lines[index];
        if (!line) break;
        const lineIndent = line.match(/^\s*/u)?.[0].length ?? 0;
        if (lineIndent < indent || !line.trimStart().startsWith('- ')) {
          break;
        }

        const itemText = line.trimStart().slice(2).trim();
        index += 1;

        if (itemText.length === 0) {
          result.push(parseBlock(indent + 2, depth + 1));
          continue;
        }

        const inlineSeparator = itemText.indexOf(':');
        if (inlineSeparator > 0) {
          const key = itemText.slice(0, inlineSeparator).trim();
          const rawValue = itemText.slice(inlineSeparator + 1).trim();
          const obj: Record<string, unknown> = {};
          obj[key] = rawValue.length === 0 ? parseBlock(indent + 2, depth + 1) : parseScalar(rawValue);

          while (index < lines.length) {
            const next = lines[index];
            if (!next) break;
            const nextIndent = next.match(/^\s*/u)?.[0].length ?? 0;
            if (nextIndent <= indent) break;
            const nextTrimmed = next.trim();
            if (nextTrimmed.startsWith('- ') && nextIndent === indent) break;
            const sep = nextTrimmed.indexOf(':');
            if (sep <= 0) break;
            const nestedKey = nextTrimmed.slice(0, sep).trim();
            const nestedRaw = nextTrimmed.slice(sep + 1).trim();
            index += 1;
            obj[nestedKey] = nestedRaw.length === 0 ? parseBlock(nextIndent + 2, depth + 1) : parseScalar(nestedRaw);
          }

          result.push(obj);
        } else {
          result.push(parseScalar(itemText));
        }
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    while (index < lines.length) {
      const line = lines[index];
      if (!line) break;
      const lineIndent = line.match(/^\s*/u)?.[0].length ?? 0;
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        index += 1;
        continue;
      }

      const trimmed = line.trim();
      const separator = trimmed.indexOf(':');
      if (separator <= 0) {
        index += 1;
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      index += 1;

      result[key] = rawValue.length === 0 ? parseBlock(indent + 2, depth + 1) : parseScalar(rawValue);
    }
    return result;
  };

  return parseBlock(0, 0);
}

export class PolicyStore {
  private readonly cache = new Map<string, OrgPolicy>();

  constructor(private readonly baseDir: string = path.join(process.cwd(), 'policies')) {}

  loadOrgPolicy(orgId: string): OrgPolicy {
    const cached = this.cache.get(orgId);
    if (cached) {
      return cached;
    }

    const yamlPath = path.join(this.baseDir, orgId, 'policy.yaml');
    const ymlPath = path.join(this.baseDir, orgId, 'policy.yml');
    const jsonPath = path.join(this.baseDir, orgId, 'policy.json');

    let raw: string | null = null;
    let parsed: unknown = null;

    if (fs.existsSync(yamlPath)) {
      raw = fs.readFileSync(yamlPath, 'utf8');
      if (raw.length > MAX_POLICY_FILE_SIZE_BYTES) throw new Error(`Policy file too large for org '${orgId}'`);
      parsed = parseSimpleYaml(raw);
    } else if (fs.existsSync(ymlPath)) {
      raw = fs.readFileSync(ymlPath, 'utf8');
      if (raw.length > MAX_POLICY_FILE_SIZE_BYTES) throw new Error(`Policy file too large for org '${orgId}'`);
      parsed = parseSimpleYaml(raw);
    } else if (fs.existsSync(jsonPath)) {
      raw = fs.readFileSync(jsonPath, 'utf8');
      if (raw.length > MAX_POLICY_FILE_SIZE_BYTES) throw new Error(`Policy file too large for org '${orgId}'`);
      parsed = JSON.parse(raw) as unknown;
    }

    const policy = OrgPolicySchema.parse(parsed ?? { version: '1', defaultEffect: 'deny', rules: [] });
    this.cache.set(orgId, policy);
    return policy;
  }

  invalidate(orgId?: string): void {
    if (orgId) {
      this.cache.delete(orgId);
      return;
    }
    this.cache.clear();
  }
}

export class AbacEngine {
  constructor(private readonly policyStore: PolicyStore = new PolicyStore()) {}

  evaluate(input: AbacRequest): AbacDecision {
    const request = AbacRequestSchema.parse(input);
    const policy = this.policyStore.loadOrgPolicy(request.orgId);

    const matchedRuleIds: string[] = [];
    let matchedAllowReason: string | null = null;

    for (const rule of policy.rules) {
      if (!this.matchesPattern(request.action, rule.actions)) {
        continue;
      }

      if (!this.matchesPattern(request.resource.type, rule.resources) && !this.matchesPattern(request.resource.id, rule.resources)) {
        continue;
      }

      if (rule.condition && !this.evaluateCondition(rule.condition, request)) {
        continue;
      }

      matchedRuleIds.push(rule.id);

      if (rule.effect === 'deny') {
        return {
          allowed: false,
          reason: rule.reason,
          matchedRuleIds,
        };
      }

      matchedAllowReason = rule.reason;
    }

    if (matchedAllowReason) {
      return {
        allowed: true,
        reason: matchedAllowReason,
        matchedRuleIds,
      };
    }

    return {
      allowed: policy.defaultEffect === 'allow',
      reason: `Default ${policy.defaultEffect} policy for org ${request.orgId}`,
      matchedRuleIds,
    };
  }

  private evaluateCondition(condition: Condition, request: AbacRequest): boolean {
    if ('all' in condition) {
      return condition.all.every((item) => this.evaluateCondition(item, request));
    }

    if ('any' in condition) {
      return condition.any.some((item) => this.evaluateCondition(item, request));
    }

    if ('not' in condition) {
      return !this.evaluateCondition(condition.not, request);
    }

    const subject = {
      subject: {
        id: request.subject.id,
        roles: request.subject.roles,
        ...request.subject.attributes,
      },
      resource: {
        id: request.resource.id,
        type: request.resource.type,
        ...request.resource.attributes,
      },
      environment: request.environment,
      request: request.request,
    };

    const actual = getByPath(subject, condition.path);

    switch (condition.op) {
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'eq':
        return actual === condition.value;
      case 'ne':
        return actual !== condition.value;
      case 'gt':
        return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
      case 'gte':
        return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
      case 'lt':
        return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
      case 'lte':
        return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(actual);
      case 'contains':
        return Array.isArray(actual)
          ? actual.includes(condition.value)
          : typeof actual === 'string' && typeof condition.value === 'string' && actual.includes(condition.value);
      default:
        return false;
    }
  }

  private matchesPattern(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => pattern === '*' || pattern === value);
  }
}
