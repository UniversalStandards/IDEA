import { z } from 'zod';

export const TenantStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export const TenantRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1),
  isDefault: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TenantSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  status: TenantStatusSchema.default('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  suspendedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).default({}),
  workspaces: z.array(WorkspaceSchema).default([]),
});

export const TenantMembershipSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  role: TenantRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TenantQuotaSchema = z.object({
  maxRequestsPerMinute: z.number().int().positive().default(300),
  maxMembers: z.number().int().positive().default(100),
  maxWorkspaces: z.number().int().positive().default(10),
});

export type Tenant = z.infer<typeof TenantSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type TenantMembership = z.infer<typeof TenantMembershipSchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
export type TenantRole = z.infer<typeof TenantRoleSchema>;
export type TenantQuota = z.infer<typeof TenantQuotaSchema>;
