import type { HealthStatus } from '../types';
import type { HttpClient } from '../http';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TenantQuota {
  readonly maxRunsPerHour: number;
  readonly maxCapabilities: number;
}

export class AdminClient {
  private readonly http: HttpClient;

  public constructor(http: HttpClient) {
    this.http = http;
  }

  public async listTenants(): Promise<Tenant[]> {
    const response = await this.http.get<{ tenants?: Tenant[]; items?: Tenant[] }>('/admin/tenants');
    return response.tenants ?? response.items ?? [];
  }

  public async getTenant(tenantId: string): Promise<Tenant> {
    return this.http.get<Tenant>(`/admin/tenants/${encodeURIComponent(tenantId)}`);
  }

  public async createTenant(tenant: Omit<Tenant, 'id'>): Promise<Tenant> {
    return this.http.post<Tenant>('/admin/tenants', { body: tenant });
  }

  public async updateTenant(tenantId: string, updates: Partial<Omit<Tenant, 'id'>>): Promise<Tenant> {
    return this.http.put<Tenant>(`/admin/tenants/${encodeURIComponent(tenantId)}`, { body: updates });
  }

  public async deleteTenant(tenantId: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/admin/tenants/${encodeURIComponent(tenantId)}`);
  }

  public async getQuota(tenantId: string): Promise<TenantQuota> {
    return this.http.get<TenantQuota>(`/admin/tenants/${encodeURIComponent(tenantId)}/quota`);
  }

  public async setQuota(tenantId: string, quota: TenantQuota): Promise<TenantQuota> {
    return this.http.put<TenantQuota>(`/admin/tenants/${encodeURIComponent(tenantId)}/quota`, {
      body: quota,
    });
  }

  public async health(): Promise<HealthStatus> {
    return this.http.get<HealthStatus>('/admin/health');
  }
}
