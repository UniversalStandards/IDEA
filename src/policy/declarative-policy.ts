/**
 * src/policy/declarative-policy.ts
 * JSON-safe policy definitions for policies supplied over the wire (MCP
 * `manage_policy`, admin tooling). Engine policies carry `condition`
 * functions, which cannot be transported; a declarative policy instead
 * describes *what* to match (tool ID, action, actor — exact or `*` glob) and
 * is compiled into an engine Policy here.
 */

import { z } from 'zod';
import type { Policy, PolicyContext } from './policy-engine';

/** Built-in policies that wire-supplied changes may never replace or remove. */
export const PROTECTED_POLICY_IDS: ReadonlySet<string> = new Set([
  'default-deny-unknown',
  'default-high-risk-approval',
  'default-allow-standard',
]);

const pattern = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9@._:/*-]+$/, 'patterns may contain letters, digits, @ . _ : / - and * only');

export const DeclarativePolicySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._:-]+$/, 'id may contain letters, digits, . _ : - only'),
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(1000).default(50),
  enabled: z.boolean().default(true),
  rules: z
    .array(
      z.object({
        match: z
          .object({
            toolId: pattern.optional(),
            action: pattern.optional(),
            actor: pattern.optional(),
          })
          .strict(),
        action: z.enum(['allow', 'deny', 'require_approval', 'log']),
        reason: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});

export type DeclarativePolicy = z.infer<typeof DeclarativePolicySchema>;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matcher(glob: string | undefined): (value: string) => boolean {
  if (glob === undefined) return () => true;
  const re = globToRegExp(glob);
  return (value: string) => re.test(value);
}

/** Validate and compile a declarative policy into an engine Policy. */
export function compileDeclarativePolicy(input: unknown): Policy {
  const parsed = DeclarativePolicySchema.parse(input);
  if (PROTECTED_POLICY_IDS.has(parsed.id)) {
    throw new Error(`Policy '${parsed.id}' is a protected built-in policy and cannot be replaced`);
  }
  return {
    id: parsed.id,
    name: parsed.name,
    priority: parsed.priority,
    enabled: parsed.enabled,
    rules: parsed.rules.map((rule) => {
      const toolMatches = matcher(rule.match.toolId);
      const actionMatches = matcher(rule.match.action);
      const actorMatches = matcher(rule.match.actor);
      return {
        condition: (ctx: PolicyContext): boolean =>
          toolMatches(ctx.toolId) && actionMatches(ctx.action) && actorMatches(ctx.actor),
        action: rule.action,
        reason: rule.reason,
      };
    }),
  };
}
