import { randomUUID, scryptSync } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import {
  TenantMembershipSchema,
  TenantSchema,
  type Tenant,
  type TenantMembership,
  type Workspace,
} from './schemas/tenant.schema';

const logger = createLogger('tenant-store');
const API_KEY_HASH_SALT = process.env['TENANT_API_KEY_SALT'] ?? 'tenant-api-key-salt-v1';

const TenantStoreSnapshotSchema = z.object({
  tenants: z.array(TenantSchema),
  memberships: z.array(TenantMembershipSchema),
  apiKeys: z.record(z.string()),
  sessions: z.record(z.array(z.string())),
});

type TenantStoreSnapshot = z.infer<typeof TenantStoreSnapshotSchema>;

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'runtime', 'tenants.json');

export type TenantCreateInput = {
  orgId: string;
  name: string;
  metadata?: Record<string, unknown>;
  workspaces?: Workspace[];
};

export type TenantUpdateInput = {
  name?: string;
  metadata?: Record<string, unknown>;
};

export class TenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly memberships = new Map<string, TenantMembership>();
  private readonly apiKeyToOrg = new Map<string, string>();
  private readonly orgSessions = new Map<string, Set<string>>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string = DEFAULT_STORE_PATH) {}

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = TenantStoreSnapshotSchema.parse(JSON.parse(raw));
      for (const tenant of parsed.tenants) {
        this.tenants.set(tenant.orgId, tenant);
      }
      for (const membership of parsed.memberships) {
        this.memberships.set(membership.id, membership);
      }
      for (const [hashedKey, orgId] of Object.entries(parsed.apiKeys)) {
        this.apiKeyToOrg.set(hashedKey, orgId);
      }
      for (const [orgId, sessions] of Object.entries(parsed.sessions)) {
        this.orgSessions.set(orgId, new Set(sessions));
      }
      logger.info('Tenant store loaded', { tenants: this.tenants.size, path: this.storePath });
    } catch (err) {
      logger.debug('Tenant store initialized with empty state', {
        path: this.storePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(orgId: string): Tenant | undefined {
    return this.tenants.get(orgId);
  }

  list(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  listMemberships(orgId: string): TenantMembership[] {
    return Array.from(this.memberships.values()).filter((membership) => membership.orgId === orgId);
  }

  async create(input: TenantCreateInput): Promise<Tenant> {
    if (this.tenants.has(input.orgId)) {
      throw new Error(`Tenant already exists: ${input.orgId}`);
    }

    const now = new Date().toISOString();
    const defaultWorkspace: Workspace = {
      id: `${input.orgId}-default`,
      orgId: input.orgId,
      name: 'Default Workspace',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };

    const tenant = TenantSchema.parse({
      orgId: input.orgId,
      name: input.name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
      workspaces: input.workspaces && input.workspaces.length > 0 ? input.workspaces : [defaultWorkspace],
    });

    this.tenants.set(tenant.orgId, tenant);
    this.orgSessions.set(tenant.orgId, new Set());
    await this.persist();
    return tenant;
  }

  async update(orgId: string, patch: TenantUpdateInput): Promise<Tenant> {
    const existing = this.tenants.get(orgId);
    if (!existing) throw new Error(`Tenant not found: ${orgId}`);

    const updated = TenantSchema.parse({
      ...existing,
      name: patch.name ?? existing.name,
      metadata: patch.metadata ?? existing.metadata,
      updatedAt: new Date().toISOString(),
    });

    this.tenants.set(orgId, updated);
    await this.persist();
    return updated;
  }

  async setStatus(orgId: string, status: 'active' | 'suspended' | 'deleted'): Promise<Tenant> {
    const existing = this.tenants.get(orgId);
    if (!existing) throw new Error(`Tenant not found: ${orgId}`);

    const now = new Date().toISOString();
    const updated = TenantSchema.parse({
      ...existing,
      status,
      updatedAt: now,
      suspendedAt: status === 'suspended' ? now : undefined,
      deletedAt: status === 'deleted' ? now : undefined,
    });

    this.tenants.set(orgId, updated);
    await this.persist();
    return updated;
  }

  async delete(orgId: string): Promise<boolean> {
    const existed = this.tenants.delete(orgId);
    if (!existed) return false;

    for (const [membershipId, membership] of this.memberships.entries()) {
      if (membership.orgId === orgId) {
        this.memberships.delete(membershipId);
      }
    }

    for (const [hashedKey, tenantOrgId] of this.apiKeyToOrg.entries()) {
      if (tenantOrgId === orgId) this.apiKeyToOrg.delete(hashedKey);
    }

    this.orgSessions.delete(orgId);
    await this.persist();
    return true;
  }

  async addMembership(membership: Omit<TenantMembership, 'id' | 'createdAt' | 'updatedAt'>): Promise<TenantMembership> {
    if (!this.tenants.has(membership.orgId)) {
      throw new Error(`Tenant not found: ${membership.orgId}`);
    }

    const now = new Date().toISOString();
    const next = TenantMembershipSchema.parse({
      ...membership,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });

    this.memberships.set(next.id, next);
    await this.persist();
    return next;
  }

  async registerApiKey(orgId: string, apiKey: string): Promise<void> {
    if (!this.tenants.has(orgId)) {
      throw new Error(`Tenant not found: ${orgId}`);
    }
    this.apiKeyToOrg.set(this.hashApiKey(apiKey), orgId);
    await this.persist();
  }

  resolveOrgIdByApiKey(apiKey: string): string | undefined {
    return this.apiKeyToOrg.get(this.hashApiKey(apiKey));
  }

  registerSession(orgId: string, sessionId: string = randomUUID()): string {
    const sessions = this.orgSessions.get(orgId);
    if (!sessions) {
      throw new Error(`Tenant not found: ${orgId}`);
    }
    sessions.add(sessionId);
    return sessionId;
  }

  getSessionCount(orgId: string): number {
    return this.orgSessions.get(orgId)?.size ?? 0;
  }

  async terminateSessions(orgId: string): Promise<number> {
    const sessions = this.orgSessions.get(orgId);
    if (!sessions) return 0;

    const count = sessions.size;
    sessions.clear();
    await this.persist();
    return count;
  }

  private hashApiKey(apiKey: string): string {
    return scryptSync(apiKey, API_KEY_HASH_SALT, 64).toString('hex');
  }

  private async persist(): Promise<void> {
    this.persistQueue = this.persistQueue
      .catch((err: unknown) => {
        logger.warn('Previous tenant store persist operation failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .then(async () => {
        const snapshot: TenantStoreSnapshot = {
          tenants: this.list(),
          memberships: Array.from(this.memberships.values()),
          apiKeys: Object.fromEntries(this.apiKeyToOrg.entries()),
          sessions: Object.fromEntries(
            Array.from(this.orgSessions.entries()).map(([orgId, sessionSet]) => [orgId, Array.from(sessionSet.values())]),
          ),
        };

        await mkdir(path.dirname(this.storePath), { recursive: true });
        await writeFile(this.storePath, JSON.stringify(snapshot, null, 2), 'utf8');
      });

    await this.persistQueue;
  }
}

export const tenantStore = new TenantStore();
