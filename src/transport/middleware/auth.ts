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

    // Every bearer token this hub issues is signed with the same JWT_SECRET,
    // so a valid signature alone is not "authorized for general runtime
    // access" — a worker-session token (see
    // adapters/upcloud-worker-factory/index.ts) is scoped to a single
    // browser/desktop session's own lifecycle calls and must not be
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
