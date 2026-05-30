import { HubClient } from '../src';

describe('HubClient auth refresh', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('auto-refreshes JWT before expiry and uses refreshed token', async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['authorization']).toMatch(/^Bearer\s+/);
        return new Response(JSON.stringify({ capabilities: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

    const hub = new HubClient({
      baseUrl: 'https://hub.example.com',
      oauth: {
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 500,
        tokenEndpoint: 'https://hub.example.com/auth/token',
      },
      refreshBufferMs: 1_000,
      fetchImpl: fetchMock,
    });

    await jest.runOnlyPendingTimersAsync();
    await hub.capabilities.list();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://hub.example.com/auth/token',
      expect.objectContaining({ method: 'POST' }),
    );

    hub.close();
  });
});
