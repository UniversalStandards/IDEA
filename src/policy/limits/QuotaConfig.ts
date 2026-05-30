import fs from 'fs';
import path from 'path';
import { z } from 'zod';

type ScalarValue = string | number | boolean | null;
const MAX_YAML_NESTING_DEPTH = 10;
const MAX_QUOTA_FILE_SIZE_BYTES = 1_000_000;

const PeriodQuotaSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  apiCalls: z.number().int().nonnegative().optional(),
  computeSeconds: z.number().int().nonnegative().optional(),
});

export const OrgQuotaConfigSchema = z.object({
  rateLimit: z
    .object({
      requests: z.object({
        windowSeconds: z.number().int().min(1).default(60),
        maxRequests: z.number().int().min(1).default(300),
      }),
      tokens: z
        .object({
          windowSeconds: z.number().int().min(1),
          maxTokens: z.number().int().min(1),
        })
        .optional(),
    })
    .default({ requests: { windowSeconds: 60, maxRequests: 300 } }),
  quota: z
    .object({
      hour: PeriodQuotaSchema.default({}),
      day: PeriodQuotaSchema.default({}),
      month: PeriodQuotaSchema.default({}),
      alertThresholds: z.array(z.number().min(0).max(1)).default([0.8, 1.0]),
    })
    .default({ hour: {}, day: {}, month: {}, alertThresholds: [0.8, 1.0] }),
});

export type OrgQuotaConfig = z.infer<typeof OrgQuotaConfigSchema>;

function parseScalar(value: string): ScalarValue {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return Number(trimmed);
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
      throw new Error(`YAML quota config exceeds maximum nesting depth (${MAX_YAML_NESTING_DEPTH})`);
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
        if (lineIndent < indent || !line.trimStart().startsWith('- ')) break;
        const itemText = line.trimStart().slice(2).trim();
        index += 1;

        if (itemText.length === 0) {
          result.push(parseBlock(indent + 2, depth + 1));
          continue;
        }

        const separator = itemText.indexOf(':');
        if (separator > 0) {
          const key = itemText.slice(0, separator).trim();
          const rawValue = itemText.slice(separator + 1).trim();
          const obj: Record<string, unknown> = {};
          obj[key] = rawValue.length === 0 ? parseBlock(indent + 2, depth + 1) : parseScalar(rawValue);
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

export class OrgQuotaConfigStore {
  private readonly cache = new Map<string, OrgQuotaConfig>();

  constructor(private readonly baseDir: string = path.join(process.cwd(), 'policies')) {}

  loadOrgConfig(orgId: string): OrgQuotaConfig {
    const cached = this.cache.get(orgId);
    if (cached) {
      return cached;
    }

    const quotaYaml = path.join(this.baseDir, orgId, 'quota.yaml');
    const quotaYml = path.join(this.baseDir, orgId, 'quota.yml');
    const quotaJson = path.join(this.baseDir, orgId, 'quota.json');

    let parsed: unknown = {};
    if (fs.existsSync(quotaYaml)) {
      const raw = fs.readFileSync(quotaYaml, 'utf8');
      if (raw.length > MAX_QUOTA_FILE_SIZE_BYTES) throw new Error(`Quota file too large for org '${orgId}'`);
      parsed = parseSimpleYaml(raw);
    } else if (fs.existsSync(quotaYml)) {
      const raw = fs.readFileSync(quotaYml, 'utf8');
      if (raw.length > MAX_QUOTA_FILE_SIZE_BYTES) throw new Error(`Quota file too large for org '${orgId}'`);
      parsed = parseSimpleYaml(raw);
    } else if (fs.existsSync(quotaJson)) {
      const raw = fs.readFileSync(quotaJson, 'utf8');
      if (raw.length > MAX_QUOTA_FILE_SIZE_BYTES) throw new Error(`Quota file too large for org '${orgId}'`);
      parsed = JSON.parse(raw) as unknown;
    }

    const config = OrgQuotaConfigSchema.parse(parsed);
    this.cache.set(orgId, config);
    return config;
  }
}
