import * as jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import { randomUUID, createHash } from 'crypto';
import { config } from '../../config';
import { auditLog } from '../audit';

export type OAuthGrantType = 'authorization_code' | 'client_credentials';

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  allowedScopes: string[];
  tenantId?: string;
}

export interface AuthorizationCodeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  subject: string;
  scope: string[];
  tenantId?: string;
  expiresInSec?: number;
}

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  subject: string;
  scope: string[];
  tenantId?: string;
  expiresAtMs: number;
  consumed: boolean;
}

export interface AuthorizationCodeExchangeRequest {
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface ClientCredentialsRequest {
  clientId: string;
  clientSecret: string;
  scope?: string[];
}

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string[];
  subject?: string;
  tenantId?: string;
  grantType: OAuthGrantType;
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

export class OAuthProvider {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly signingKey: string;

  constructor(
    private readonly logger: AuditRecorder = auditLog,
    signingKey: string = config.JWT_SECRET
  ) {
    this.signingKey = signingKey;
  }

  registerClient(client: OAuthClient): void {
    this.clients.set(client.clientId, client);
    this.logger.record('oauth.client.register', 'system', client.clientId, 'success', undefined, {
      tenantId: client.tenantId ?? null,
    });
  }

  issueAuthorizationCode(request: AuthorizationCodeRequest): string {
    const client = this.clients.get(request.clientId);
    if (!client) {
      this.auditFail('oauth.authorization_code.issue', request.clientId, 'unknown_client');
      throw new Error('Unknown OAuth client');
    }

    if (!client.redirectUris.includes(request.redirectUri)) {
      this.auditFail('oauth.authorization_code.issue', request.clientId, 'invalid_redirect_uri');
      throw new Error('Invalid redirect URI');
    }

    if (request.tenantId && client.tenantId && request.tenantId !== client.tenantId) {
      this.auditFail('oauth.authorization_code.issue', request.clientId, 'tenant_mismatch');
      throw new Error('Tenant mismatch');
    }

    const invalidScope = request.scope.find((scope) => !client.allowedScopes.includes(scope));
    if (invalidScope) {
      this.auditFail('oauth.authorization_code.issue', request.clientId, 'invalid_scope');
      throw new Error(`Invalid scope: ${invalidScope}`);
    }

    const code = randomUUID().replace(/-/g, '');
    const codeRecord: AuthorizationCodeRecord = {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      subject: request.subject,
      scope: request.scope,
      expiresAtMs: Date.now() + (request.expiresInSec ?? 300) * 1_000,
      consumed: false,
    };
    if (request.tenantId) codeRecord.tenantId = request.tenantId;
    this.authorizationCodes.set(code, codeRecord);

    this.logger.record('oauth.authorization_code.issue', request.subject, request.clientId, 'success', undefined, {
      scope: request.scope,
      tenantId: request.tenantId ?? null,
    });

    return code;
  }

  exchangeAuthorizationCode(request: AuthorizationCodeExchangeRequest): OAuthTokenResponse {
    const client = this.clients.get(request.clientId);
    if (!client) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'unknown_client');
      throw new Error('Unknown OAuth client');
    }

    if (client.clientSecret && client.clientSecret !== request.clientSecret) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'invalid_client_secret');
      throw new Error('Invalid client credentials');
    }

    const record = this.authorizationCodes.get(request.code);
    if (!record || record.clientId !== request.clientId) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'invalid_code');
      throw new Error('Invalid authorization code');
    }

    if (record.consumed) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'code_already_consumed');
      throw new Error('Authorization code already consumed');
    }

    if (Date.now() > record.expiresAtMs) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'code_expired');
      throw new Error('Authorization code expired');
    }

    if (record.redirectUri !== request.redirectUri) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'redirect_uri_mismatch');
      throw new Error('Redirect URI mismatch');
    }

    if (!this.verifyPkce(record.codeChallenge, record.codeChallengeMethod, request.codeVerifier)) {
      this.auditFail('oauth.authorization_code.exchange', request.clientId, 'invalid_pkce_verifier');
      throw new Error('Invalid PKCE code verifier');
    }

    record.consumed = true;
    const token = this.issueJwt({
      sub: record.subject,
      aud: request.clientId,
      tenantId: record.tenantId,
      scope: record.scope,
      grantType: 'authorization_code',
    });

    const response: OAuthTokenResponse = {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: record.scope,
      subject: record.subject,
      grantType: 'authorization_code',
    };
    if (record.tenantId) response.tenantId = record.tenantId;

    this.logger.record('oauth.authorization_code.exchange', record.subject, request.clientId, 'success', undefined, {
      scope: record.scope,
      tenantId: record.tenantId ?? null,
    });

    return response;
  }

  issueClientCredentialsToken(request: ClientCredentialsRequest): OAuthTokenResponse {
    const client = this.clients.get(request.clientId);
    if (!client || !client.clientSecret || client.clientSecret !== request.clientSecret) {
      this.auditFail('oauth.client_credentials.issue', request.clientId, 'invalid_client_credentials');
      throw new Error('Invalid client credentials');
    }

    const scope = request.scope?.length ? request.scope : client.allowedScopes;
    const invalidScope = scope.find((requestedScope) => !client.allowedScopes.includes(requestedScope));
    if (invalidScope) {
      this.auditFail('oauth.client_credentials.issue', request.clientId, 'invalid_scope');
      throw new Error(`Invalid scope: ${invalidScope}`);
    }

    const token = this.issueJwt({
      sub: request.clientId,
      aud: request.clientId,
      tenantId: client.tenantId,
      scope,
      grantType: 'client_credentials',
    });

    const response: OAuthTokenResponse = {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope,
      subject: request.clientId,
      grantType: 'client_credentials',
    };
    if (client.tenantId) response.tenantId = client.tenantId;

    this.logger.record('oauth.client_credentials.issue', request.clientId, request.clientId, 'success', undefined, {
      scope,
      tenantId: client.tenantId ?? null,
    });

    return response;
  }

  verifyAccessToken(token: string): JwtPayload {
    return jwt.verify(token, this.signingKey) as JwtPayload;
  }

  private issueJwt(payload: Record<string, unknown>): string {
    return jwt.sign(payload, this.signingKey, { expiresIn: 3600, issuer: 'idea-security', jwtid: randomUUID() });
  }

  private verifyPkce(codeChallenge: string, method: 'S256' | 'plain', codeVerifier: string): boolean {
    if (method === 'plain') {
      return codeChallenge === codeVerifier;
    }

    const digest = createHash('sha256').update(codeVerifier).digest('base64url');
    return digest === codeChallenge;
  }

  private auditFail(action: string, resource: string, reason: string): void {
    this.logger.record(action, 'system', resource, 'failure', undefined, { reason });
  }
}
