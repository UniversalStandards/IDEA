import type { CapabilityDescriptor, NormalizedResult } from '../types';
import type { HttpClient } from '../http';

export interface CapabilityInstallResponse {
  readonly id: string;
  readonly installed: boolean;
  readonly message?: string;
}

export class CapabilityClient {
  private readonly http: HttpClient;

  public constructor(http: HttpClient) {
    this.http = http;
  }

  public async search(query: string): Promise<CapabilityDescriptor[]> {
    const response = await this.http.get<{ capabilities?: CapabilityDescriptor[]; results?: CapabilityDescriptor[] }>(
      '/capabilities/search',
      { query: { query } },
    );
    return response.capabilities ?? response.results ?? [];
  }

  public async install(id: string): Promise<CapabilityInstallResponse> {
    return this.http.post<CapabilityInstallResponse>(`/capabilities/${encodeURIComponent(id)}/install`);
  }

  public async list(orgId?: string): Promise<CapabilityDescriptor[]> {
    const response = await this.http.get<{ capabilities?: CapabilityDescriptor[]; items?: CapabilityDescriptor[] }>(
      '/capabilities',
      {
        query: { orgId },
      },
    );
    return response.capabilities ?? response.items ?? [];
  }

  public async invoke(id: string, args: Record<string, unknown>): Promise<NormalizedResult> {
    return this.http.post<NormalizedResult>(`/capabilities/${encodeURIComponent(id)}/invoke`, {
      body: { args },
    });
  }
}
