export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}

export enum TenantPlan {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: TenantPlan;
  readonly createdAt: string;
  readonly settings: Record<string, unknown>;
}

export interface Workspace {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly config: Record<string, unknown>;
}

export interface TenantMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
  readonly joinedAt: string;
}
