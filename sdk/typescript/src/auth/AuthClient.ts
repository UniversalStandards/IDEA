export interface OAuthConfig {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: string;
}

export interface AuthClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly oauth?: OAuthConfig;
  readonly fetchImpl?: typeof fetch;
  readonly refreshBufferMs?: number;
}

export interface TokenRefreshResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

export class AuthClient {
  private apiKey: string | undefined;
  private oauth: OAuthConfig | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly refreshBufferMs: number;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: AuthClientOptions) {
    this.baseUrl = AuthClient.trimTrailingSlashes(options.baseUrl);
    this.apiKey = options.apiKey;
    this.oauth = options.oauth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshBufferMs = options.refreshBufferMs ?? 60_000;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  public setOAuth(config: OAuthConfig): void {
    this.oauth = config;
    this.scheduleRefresh();
  }

  public getOAuth(): OAuthConfig | undefined {
    return this.oauth;
  }

  public async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    if (this.oauth?.accessToken) {
      headers['authorization'] = 'Bearer ' + this.oauth.accessToken;
    }

    return headers;
  }

  public async ensureFreshToken(): Promise<void> {
    if (!this.oauth || !this.shouldRefresh()) {
      return;
    }

    await this.refreshJwt();
  }

  public async refreshJwt(): Promise<string> {
    if (!this.oauth?.refreshToken) {
      throw new Error('Cannot refresh JWT without refreshToken');
    }

    const endpoint = this.oauth.tokenEndpoint ?? `${this.baseUrl}/auth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.oauth.refreshToken,
      ...(this.oauth.clientId ? { client_id: this.oauth.clientId } : {}),
      ...(this.oauth.clientSecret ? { client_secret: this.oauth.clientSecret } : {}),
      ...(this.oauth.scope ? { scope: this.oauth.scope } : {}),
    });

    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`JWT refresh failed with status ${String(response.status)}`);
    }

    const payload = (await response.json()) as TokenRefreshResponse;
    const now = Date.now();
    const expiresInMs = (payload.expires_in ?? 3600) * 1000;

    this.oauth = {
      ...this.oauth,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? this.oauth.refreshToken,
      expiresAt: now + expiresInMs,
    };

    this.scheduleRefresh();
    return payload.access_token;
  }

  public startAutoRefresh(): void {
    this.scheduleRefresh();
  }

  public stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private shouldRefresh(): boolean {
    if (!this.oauth?.expiresAt || !this.oauth.refreshToken) {
      return false;
    }

    return Date.now() >= this.oauth.expiresAt - this.refreshBufferMs;
  }

  private scheduleRefresh(): void {
    this.stopAutoRefresh();

    if (!this.oauth?.expiresAt || !this.oauth.refreshToken) {
      return;
    }

    const delayMs = Math.max(this.oauth.expiresAt - Date.now() - this.refreshBufferMs, 0);
    this.refreshTimer = setTimeout(() => {
      void this.refreshJwt();
    }, delayMs);
  }

  private static trimTrailingSlashes(value: string): string {
    let normalized = value;
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }
}
