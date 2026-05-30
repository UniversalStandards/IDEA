import * as jwt from 'jsonwebtoken';
import { decode, type JwtHeader, type JwtPayload, type VerifyErrors, type Algorithm } from 'jsonwebtoken';
import { createPublicKey, type KeyObject } from 'crypto';
import { auditLog } from '../audit';

export interface JwkKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

export interface JwksResponse {
  keys: JwkKey[];
}

export interface OidcProviderOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  clockToleranceSec?: number;
  jwksRefreshMs?: number;
  fetchFn?: (input: string) => Promise<{ ok: boolean; status: number; json: () => Promise<JwksResponse> }>;
  logger?: AuditRecorder;
}

interface AuditRecorder {
  record: (
    action: string,
    actor: string,
    resource: string,
    outcome: 'success' | 'failure' | 'pending',
    correlationId?: string,
    meta?: Record<string, unknown>
  ) => void;
}

interface JwksKeyCacheEntry {
  keyObject: KeyObject;
  alg: Algorithm;
}

export class OidcProvider {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: string;
  private readonly clockToleranceSec: number;
  private readonly jwksRefreshMs: number;
  private readonly fetchFn: OidcProviderOptions['fetchFn'];
  private readonly logger: AuditRecorder;

  private jwksCache = new Map<string, JwksKeyCacheEntry>();
  private lastRefreshAtMs = 0;

  constructor(options: OidcProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.jwksUri = options.jwksUri;
    this.clockToleranceSec = options.clockToleranceSec ?? 30;
    this.jwksRefreshMs = options.jwksRefreshMs ?? 5 * 60_000;
    this.fetchFn =
      options.fetchFn ??
      (async (input: string) => {
        const response = await fetch(input);
        return {
          ok: response.ok,
          status: response.status,
          json: async () => (await response.json()) as JwksResponse,
        };
      });
    this.logger = options.logger ?? auditLog;
  }

  async validateIdToken(idToken: string): Promise<JwtPayload> {
    const decoded = decode(idToken, { complete: true }) as { header: JwtHeader } | null;
    const kid = decoded?.header?.kid;
    if (!kid) {
      this.auditFailure('oidc.id_token.validate', 'missing_kid');
      throw new Error('OIDC token missing kid header');
    }

    let key = await this.getKeyForKid(kid);
    if (!key) {
      await this.refreshJwks(true);
      key = await this.getKeyForKid(kid);
    }

    if (!key) {
      this.auditFailure('oidc.id_token.validate', 'unknown_kid');
      throw new Error('OIDC token kid not found in JWKS');
    }

    const payload = await new Promise<JwtPayload>((resolve, reject) => {
      jwt.verify(
        idToken,
        key.keyObject,
        {
          algorithms: [key.alg],
          issuer: this.issuer,
          audience: this.audience,
          clockTolerance: this.clockToleranceSec,
        },
        (err: VerifyErrors | null, value: string | JwtPayload | undefined) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(value as JwtPayload);
        }
      );
    }).catch((err) => {
      this.auditFailure('oidc.id_token.validate', 'signature_or_claim_validation_failed');
      throw err;
    });

    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      this.auditFailure('oidc.id_token.validate', 'missing_iat_or_exp');
      throw new Error('OIDC token missing required temporal claims');
    }

    this.logger.record('oidc.id_token.validate', String(payload.sub ?? 'unknown'), this.issuer, 'success', undefined, {
      aud: payload.aud,
      iss: payload.iss,
    });

    return payload;
  }

  async refreshJwks(force = false): Promise<void> {
    if (!force && Date.now() - this.lastRefreshAtMs < this.jwksRefreshMs) {
      return;
    }

    const response = await this.fetchFn!(this.jwksUri);
    if (!response.ok) {
      this.auditFailure('oidc.jwks.refresh', `http_${String(response.status)}`);
      throw new Error(`Failed to refresh JWKS (${String(response.status)})`);
    }

    const body = await response.json();
    const next = new Map<string, JwksKeyCacheEntry>();

    for (const key of body.keys) {
      if (!key.kid) continue;
      if (key.kty !== 'RSA') continue;
      if (!key.n || !key.e) continue;

      const keyObject = createPublicKey({
        key: {
          kty: 'RSA',
          n: key.n,
          e: key.e,
        },
        format: 'jwk',
      });

      next.set(key.kid, {
        keyObject,
        alg: (key.alg ?? 'RS256') as Algorithm,
      });
    }

    this.jwksCache = next;
    this.lastRefreshAtMs = Date.now();

    this.logger.record('oidc.jwks.refresh', 'system', this.jwksUri, 'success', undefined, {
      keyCount: this.jwksCache.size,
    });
  }

  private async getKeyForKid(kid: string): Promise<JwksKeyCacheEntry | undefined> {
    await this.refreshJwks(false);
    return this.jwksCache.get(kid);
  }

  private auditFailure(action: string, reason: string): void {
    this.logger.record(action, 'system', this.jwksUri, 'failure', undefined, { reason });
  }
}
