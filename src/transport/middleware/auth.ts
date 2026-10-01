import jwt from 'jsonwebtoken';
import type { Config } from '../../config';

export interface TransportAuthOptions {
  readonly authorization?: string | undefined;
  readonly token?: string | undefined;
  readonly config: Pick<Config, 'JWT_SECRET'>;
  readonly required?: boolean | undefined;
}

export function isTransportAuthorized(options: TransportAuthOptions): boolean {
  const token = extractBearerToken(options.authorization) ?? options.token;

  if (!token) {
    return options.required === false;
  }

  try {
    const decoded = jwt.verify(token, options.config.JWT_SECRET);

    // Worker-session tokens (see adapters/upcloud-worker-factory/index.ts)
    // are signed with deriveWorkerSessionKey(JWT_SECRET), not JWT_SECRET
    // itself, so jwt.verify() above already throws on a genuine
    // worker-session token before this point is reached. This explicit
    // scope check is defense-in-depth — it still catches a token that was
    // (incorrectly) signed with JWT_SECRET directly and carries a
    // worker-session scope claim, so a worker-session token can never be
    // replayable here to reach runtimeManager.handleRequest with full
    // capability access via SSE/WebSocket/gRPC. Mirrors the same check in
    // api/admin-api.ts's requireAuth.
    if (typeof decoded === 'object' && decoded !== null && (decoded as Record<string, unknown>)['scope'] === 'worker-session') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function extractBearerToken(authorization?: string): string | undefined {
  if (!authorization?.startsWith('Bearer ')) {
    return undefined;
  }
  return authorization.slice(7);
}
