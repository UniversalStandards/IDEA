import type { NextFunction, Request, Response } from 'express';

export type ApiVersion = `v${number}`;

const ACCEPT_VERSION_PATTERN = /application\/vnd\.hub\.(v\d+)\+json/i;
const URL_VERSION_PATTERN = /\/api\/(v\d+)(?:\/|$)/i;

declare module 'express-serve-static-core' {
  interface Request {
    apiVersion?: ApiVersion;
  }
}

export function extractApiVersion(req: Request): ApiVersion {
  const acceptHeader = req.headers['accept'];
  if (typeof acceptHeader === 'string') {
    const match = acceptHeader.match(ACCEPT_VERSION_PATTERN);
    if (match?.[1]) {
      return match[1] as ApiVersion;
    }
  }

  const fromUrl = req.originalUrl.match(URL_VERSION_PATTERN)?.[1];
  if (fromUrl) {
    return fromUrl as ApiVersion;
  }

  return 'v1';
}

export function versionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const version = extractApiVersion(req);
  req.apiVersion = version;
  res.setHeader('Vary', 'Accept');

  if (version === 'v1') {
    res.setHeader('Deprecation', 'true');
  }

  next();
}
