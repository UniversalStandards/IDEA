import { AuthClient } from './auth/AuthClient';

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  public constructor(status: number, body: unknown) {
    super(`Hub request failed with status ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly auth: AuthClient;
  private readonly fetchImpl: typeof fetch;

  public constructor(baseUrl: string, auth: AuthClient, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  public async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  public async post<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  public async put<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  public async delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  public getFetch(): typeof fetch {
    return this.fetchImpl;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async getAuthHeaders(): Promise<Record<string, string>> {
    return this.auth.getAuthHeaders();
  }

  private async request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    await this.auth.ensureFreshToken();
    const authHeaders = await this.auth.getAuthHeaders();
    const requestInit: RequestInit = {
      method,
      headers: {
        ...(options?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...authHeaders,
        ...options?.headers,
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    };

    const response = await this.fetchImpl(this.buildUrl(path, options?.query), requestInit);

    const payload = await this.parseResponse(response);
    if (!response.ok) {
      throw new HttpError(response.status, payload);
    }

    return payload as T;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const prefixedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${prefixedPath}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async parseResponse(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return { success: true };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json() as Promise<unknown>;
    }

    const text = await response.text();
    return { message: text };
  }
}
