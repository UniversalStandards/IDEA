import { EventEmitter } from 'events';
import { createLogger } from '../observability/logger';
import { type Tenant, type TenantMembership } from './schemas/tenant.schema';
import { type TenantCreateInput, type TenantUpdateInput, TenantStore } from './TenantStore';

const logger = createLogger('tenant-manager');

export type TenantLifecycleEvent =
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.suspended'
  | 'tenant.deleted'
  | 'tenant.sessions.terminated';

export class TenantManager extends EventEmitter {
  constructor(private readonly store: TenantStore) {
    super();
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async create(input: TenantCreateInput): Promise<Tenant> {
    const tenant = await this.store.create(input);
    this.emitLifecycle('tenant.created', tenant.orgId, { tenant });
    return tenant;
  }

  async update(orgId: string, patch: TenantUpdateInput): Promise<Tenant> {
    const tenant = await this.store.update(orgId, patch);
    this.emitLifecycle('tenant.updated', orgId, { tenant });
    return tenant;
  }

  async suspend(orgId: string): Promise<Tenant> {
    const tenant = await this.store.setStatus(orgId, 'suspended');
    this.emitLifecycle('tenant.suspended', orgId, { tenant });

    const terminatedSessions = await this.terminateSessions(orgId, 5_000);
    this.emitLifecycle('tenant.sessions.terminated', orgId, { terminatedSessions });

    return tenant;
  }

  async activate(orgId: string): Promise<Tenant> {
    return this.store.setStatus(orgId, 'active');
  }

  async delete(orgId: string): Promise<boolean> {
    await this.store.setStatus(orgId, 'deleted');
    const deleted = await this.store.delete(orgId);
    if (deleted) {
      this.emitLifecycle('tenant.deleted', orgId, {});
    }
    return deleted;
  }

  get(orgId: string): Tenant | undefined {
    return this.store.get(orgId);
  }

  list(): Tenant[] {
    return this.store.list();
  }

  async registerApiKey(orgId: string, apiKey: string): Promise<void> {
    await this.store.registerApiKey(orgId, apiKey);
  }

  resolveOrgIdByApiKey(apiKey: string): string | undefined {
    return this.store.resolveOrgIdByApiKey(apiKey);
  }

  registerSession(orgId: string, sessionId?: string): string {
    return this.store.registerSession(orgId, sessionId);
  }

  getSessionCount(orgId: string): number {
    return this.store.getSessionCount(orgId);
  }

  async addMembership(
    membership: Omit<TenantMembership, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<TenantMembership> {
    return this.store.addMembership(membership);
  }

  private async terminateSessions(orgId: string, timeoutMs: number): Promise<number> {
    const timeoutPromise = new Promise<number>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Session termination timed out for ${orgId}`)), timeoutMs);
      timeout.unref();
    });

    const terminationPromise = this.store.terminateSessions(orgId);
    const result = await Promise.race([terminationPromise, timeoutPromise]);
    return result;
  }

  private emitLifecycle(event: TenantLifecycleEvent, orgId: string, metadata: Record<string, unknown>): void {
    const payload = { orgId, at: new Date().toISOString(), ...metadata };
    logger.info('Tenant lifecycle event', { event, orgId });
    this.emit(event, payload);
  }
}

export const tenantManager = new TenantManager(new TenantStore());
