import axios, { type AxiosInstance } from 'axios';

export type CommunityPlugin = {
  fullName: string;
  name: string;
  description: string;
  url: string;
  stars: number;
  updatedAt: string;
};

type GithubSearchResponse = {
  items: Array<{
    full_name: string;
    name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    updated_at: string;
  }>;
};

export class PluginRegistry {
  private readonly http: AxiosInstance;

  constructor(httpClient?: AxiosInstance, githubToken?: string) {
    if (httpClient) {
      this.http = httpClient;
      return;
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    this.http = axios.create({
      baseURL: 'https://api.github.com',
      timeout: 10_000,
      headers,
    });
  }

  async search(keyword: string, limit = 20): Promise<CommunityPlugin[]> {
    const trimmed = keyword.trim();
    const query = trimmed ? `topic:mcp-hub-plugin ${trimmed}` : 'topic:mcp-hub-plugin';

    const response = await this.http.get<GithubSearchResponse>('/search/repositories', {
      params: {
        q: query,
        sort: 'stars',
        order: 'desc',
        per_page: Math.min(Math.max(limit, 1), 100),
      },
    });

    return response.data.items.map((item) => ({
      fullName: item.full_name,
      name: item.name,
      description: item.description ?? '',
      url: item.html_url,
      stars: item.stargazers_count,
      updatedAt: item.updated_at,
    }));
  }
}
