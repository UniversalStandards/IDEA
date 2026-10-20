/**
 * src/cli/admin.ts
 * Operator CLI for a running hub (HTTP modes). Mints a short-lived admin JWT
 * from the hub's own JWT_SECRET and calls the local Admin API, so it is meant
 * to run where the hub's environment is available:
 *
 *   docker exec <hub> node /app/dist/cli/admin.js approvals list
 *   docker exec <hub> node /app/dist/cli/admin.js approvals approve <id> [note]
 *   docker exec <hub> node /app/dist/cli/admin.js approvals reject  <id> [note]
 *   docker exec <hub> node /app/dist/cli/admin.js token [ttlSeconds]
 *
 * HUB_URL overrides the target (default http://127.0.0.1:$PORT).
 * Output is JSON on stdout; errors go to stderr with a non-zero exit code.
 */

import jwt from 'jsonwebtoken';

export interface AdminCliEnv {
  readonly JWT_SECRET?: string | undefined;
  readonly PORT?: string | undefined;
  readonly HUB_URL?: string | undefined;
}

const USAGE = [
  'Usage:',
  '  admin.js approvals list',
  '  admin.js approvals approve <id> [note]',
  '  admin.js approvals reject <id> [note]',
  '  admin.js token [ttlSeconds]',
].join('\n');

export function mintAdminToken(secret: string, ttlSeconds = 300): string {
  return jwt.sign({ sub: 'cli-admin', scope: 'admin' }, secret, {
    expiresIn: Math.max(30, Math.min(ttlSeconds, 86_400)),
  });
}

export function hubBaseUrl(env: AdminCliEnv): string {
  return (env.HUB_URL ?? `http://127.0.0.1:${env.PORT ?? '3000'}`).replace(/\/+$/, '');
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function request(
  fetchImpl: Fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as Record<string, unknown>)['error'])
        : res.statusText;
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return body;
}

/** Run one CLI command; returns the JSON-serialisable result. */
export async function runAdminCommand(
  argv: string[],
  env: AdminCliEnv,
  fetchImpl: Fetch = fetch,
): Promise<unknown> {
  const secret = env.JWT_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error('JWT_SECRET (min 32 chars) must be set in the environment');
  }
  const [group, command, id, ...rest] = argv;

  if (group === 'token') {
    const ttl = Number.parseInt(command ?? '300', 10);
    return { token: mintAdminToken(secret, Number.isFinite(ttl) ? ttl : 300) };
  }

  if (group !== 'approvals') {
    throw new Error(USAGE);
  }

  const token = mintAdminToken(secret);
  const base = `${hubBaseUrl(env)}/admin/approvals`;

  if (command === 'list') {
    return request(fetchImpl, `${base}/pending`, token);
  }
  if ((command === 'approve' || command === 'reject') && id !== undefined && id.length > 0) {
    const note = rest.join(' ').trim();
    return request(fetchImpl, `${base}/${encodeURIComponent(id)}/decide`, token, {
      method: 'POST',
      body: JSON.stringify({ approved: command === 'approve', ...(note !== '' ? { note } : {}) }),
    });
  }
  throw new Error(USAGE);
}

if (require.main === module) {
  runAdminCommand(process.argv.slice(2), process.env).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
