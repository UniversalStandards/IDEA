/**
 * tests/cli-admin.test.ts
 * Unit tests for the operator CLI (src/cli/admin.ts).
 */

import jwt from 'jsonwebtoken';
import { hubBaseUrl, mintAdminToken, runAdminCommand } from '../src/cli/admin';

const SECRET = 'admin-cli-test-secret-of-32-characters!!';

function fakeFetch(status = 200, body: unknown = { ok: true }): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Status',
    json: () => Promise.resolve(body),
  });
}

describe('mintAdminToken()', () => {
  it('issues a short-lived admin token signed with JWT_SECRET', () => {
    const decoded = jwt.verify(mintAdminToken(SECRET, 120), SECRET) as jwt.JwtPayload;
    expect(decoded['sub']).toBe('cli-admin');
    expect(decoded['scope']).toBe('admin');
    expect((decoded.exp ?? 0) - (decoded.iat ?? 0)).toBe(120);
  });

  it('clamps the lifetime between 30 seconds and one day', () => {
    const short = jwt.decode(mintAdminToken(SECRET, 1)) as jwt.JwtPayload;
    const long = jwt.decode(mintAdminToken(SECRET, 10_000_000)) as jwt.JwtPayload;
    expect((short.exp ?? 0) - (short.iat ?? 0)).toBe(30);
    expect((long.exp ?? 0) - (long.iat ?? 0)).toBe(86_400);
  });
});

describe('hubBaseUrl()', () => {
  it('defaults to the local listener on PORT and honors HUB_URL', () => {
    expect(hubBaseUrl({})).toBe('http://127.0.0.1:3000');
    expect(hubBaseUrl({ PORT: '4100' })).toBe('http://127.0.0.1:4100');
    expect(hubBaseUrl({ HUB_URL: 'https://hub.example.com/' })).toBe('https://hub.example.com');
  });
});

describe('runAdminCommand()', () => {
  const env = { JWT_SECRET: SECRET, PORT: '3999' };

  it('requires JWT_SECRET', async () => {
    await expect(runAdminCommand(['approvals', 'list'], {})).rejects.toThrow('JWT_SECRET');
  });

  it('lists pending approvals with a bearer token', async () => {
    const f = fakeFetch(200, { pending: [] });
    await expect(runAdminCommand(['approvals', 'list'], env, f)).resolves.toEqual({ pending: [] });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3999/admin/approvals/pending');
    const auth = (init.headers as Record<string, string>)['Authorization'] ?? '';
    expect(jwt.verify(auth.replace('Bearer ', ''), SECRET)).toBeTruthy();
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('%ss an approval with an optional note', async (command, approved) => {
    const f = fakeFetch(200, { approval: { status: 'x' } });
    await runAdminCommand(['approvals', command, 'id-1', 'looks', 'good'], env, f);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3999/admin/approvals/id-1/decide');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ approved, note: 'looks good' });
  });

  it('omits an empty note', async () => {
    const f = fakeFetch();
    await runAdminCommand(['approvals', 'approve', 'id-2'], env, f);
    expect(JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ approved: true });
  });

  it('surfaces API errors with the status code', async () => {
    await expect(runAdminCommand(['approvals', 'list'], env, fakeFetch(409, { error: 'already decided' }))).rejects.toThrow(
      'HTTP 409: already decided',
    );
    await expect(runAdminCommand(['approvals', 'list'], env, fakeFetch(500, 'oops'))).rejects.toThrow('HTTP 500: Status');
  });

  it('mints a token on request', async () => {
    const result = (await runAdminCommand(['token', '600'], env)) as { token: string };
    expect(jwt.verify(result.token, SECRET)).toBeTruthy();
    const fallback = (await runAdminCommand(['token', 'abc'], env)) as { token: string };
    expect(jwt.verify(fallback.token, SECRET)).toBeTruthy();
  });

  it.each([[[]], [['approvals']], [['approvals', 'approve']], [['other']]])('prints usage for %j', async (argv) => {
    await expect(runAdminCommand(argv, env, fakeFetch())).rejects.toThrow('Usage:');
  });
});
