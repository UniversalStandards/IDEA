import { z } from 'zod';
import { TenantPlan, TenantStatus } from '../tenant.types';

export const TenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.nativeEnum(TenantStatus),
  plan: z.nativeEnum(TenantPlan),
  createdAt: z.string().min(1),
  settings: z.object({}).catchall(z.unknown()),
});

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  config: z.object({}).catchall(z.unknown()),
});

export const TenantMembershipSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  joinedAt: z.string().min(1),
});
