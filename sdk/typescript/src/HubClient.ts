import { AuthClient, type OAuthConfig } from './auth/AuthClient';
import { HttpClient } from './http';
import { CapabilityClient } from './capabilities/CapabilityClient';
import { WorkflowClient } from './workflows/WorkflowClient';
import { StreamClient } from './streaming/StreamClient';
import { AdminClient } from './admin/AdminClient';

export interface HubClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly oauth?: OAuthConfig;
  readonly fetchImpl?: typeof fetch;
  readonly refreshBufferMs?: number;
}

export class HubClient {
  public readonly auth: AuthClient;
  public readonly capabilities: CapabilityClient;
  public readonly workflows: WorkflowClient;
  public readonly streaming: StreamClient;
  public readonly admin: AdminClient;

  private readonly http: HttpClient;

  public constructor(options: HubClientOptions) {
    this.auth = new AuthClient({
      baseUrl: options.baseUrl,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.oauth ? { oauth: options.oauth } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.refreshBufferMs !== undefined ? { refreshBufferMs: options.refreshBufferMs } : {}),
    });
    this.auth.startAutoRefresh();

    this.http = new HttpClient(options.baseUrl, this.auth, options.fetchImpl);
    this.capabilities = new CapabilityClient(this.http);
    this.workflows = new WorkflowClient(this.http);
    this.streaming = new StreamClient(this.http);
    this.admin = new AdminClient(this.http);
  }

  public stream(streamId: string): AsyncIterableIterator<import('./streaming/StreamClient').StreamEvent> {
    return this.streaming.subscribe(streamId);
  }

  public close(): void {
    this.auth.stopAutoRefresh();
  }
}
