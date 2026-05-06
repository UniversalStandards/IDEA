import jwt from 'jsonwebtoken';
import type { Config } from '../../config';
import { constantTimeEqual } from '../../security/crypto';

export interface TransportAuthOptions {
  readonly authorization?: string | undefined;
  readonly token?: string | undefined;
  readonly config: Pick<Config, 'JWT_SECRET'>;
  readonly required?: boolean | undefined;
}

export function isTransportAuthorized(options: TransportAuthOptions): boolean {
  const token = extractBearerToken(options.authorization) ?? options.token;

  if (!token) {
    return options.required ?? false ? false : true;
  }

  if (constantTimeEqual(token, options.config.JWT_SECRET)) {
    return true;
  }

  try {
    jwt.verify(token, options.config.JWT_SECRET);
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
