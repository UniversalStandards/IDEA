import { z } from 'zod';

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  action: z.string().min(1),
  resource: z.string().min(1),
  conditions: z.object({}).catchall(z.unknown()).optional(),
});

export const RbacRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  permissions: z.array(z.string().min(1)),
  inherits: z.array(z.string().min(1)),
});

export const AbacPolicySchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1),
  rules: z.array(PolicyRuleSchema),
});

export const CsaTrustLevelSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  name: z.string().min(1),
  permissions: z.array(z.string().min(1)),
});

export const QuotaConfigSchema = z.object({
  orgId: z.string().min(1),
  maxRequestsPerMinute: z.number().int().nonnegative(),
  maxRequestsPerDay: z.number().int().nonnegative(),
  maxConcurrentWorkflows: z.number().int().nonnegative(),
});

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().nonnegative(),
  burst: z.number().int().nonnegative().optional(),
});
