import { createHash, generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';

process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-jwt-secret-min-32-characters!!!';
process.env['ENCRYPTION_KEY'] = process.env['ENCRYPTION_KEY'] ?? 'test-encryption-key-min-32-characters';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../../src/observability/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('OAuthProvider', () => {
  it('supports authorization_code + PKCE and client_credentials flows', async () => {
    const records: Array<{ action: string; event: unknown }> = [];
    const audit = { record: (action: string, event: unknown) => records.push({ action, event }) };

    const { OAuthProvider } = await import('../../src/security/auth/OAuthProvider');
    const provider = new OAuthProvider(audit);

    provider.registerClient({
      clientId: 'client-app',
      clientSecret: 'client-secret',
      redirectUris: ['https://app.example/callback'],
      allowedScopes: ['read', 'write'],
      tenantId: 'tenant-a',
    });

    const codeVerifier = 'verifier-123';
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const authCode = provider.issueAuthorizationCode({
      clientId: 'client-app',
      redirectUri: 'https://app.example/callback',
      codeChallenge,
      codeChallengeMethod: 'S256',
      subject: 'user-123',
      scope: ['read'],
      tenantId: 'tenant-a',
    });

    const exchanged = provider.exchangeAuthorizationCode({
      clientId: 'client-app',
      clientSecret: 'client-secret',
      code: authCode,
      redirectUri: 'https://app.example/callback',
      codeVerifier,
    });

    expect(exchanged.grantType).toBe('authorization_code');
    expect(exchanged.scope).toEqual(['read']);
    const payload = provider.verifyAccessToken(exchanged.accessToken);
    expect(payload.sub).toBe('user-123');

    expect(() =>
      provider.exchangeAuthorizationCode({
        clientId: 'client-app',
        clientSecret: 'client-secret',
        code: authCode,
        redirectUri: 'https://app.example/callback',
        codeVerifier,
      })
    ).toThrow('Authorization code already consumed');

    const m2m = provider.issueClientCredentialsToken({
      clientId: 'client-app',
      clientSecret: 'client-secret',
      scope: ['write'],
    });

    expect(m2m.grantType).toBe('client_credentials');
    expect(provider.verifyAccessToken(m2m.accessToken)['grantType']).toBe('client_credentials');

    expect(records.some((entry) => entry.action === 'oauth.authorization_code.exchange')).toBe(true);
    expect(records.some((entry) => entry.action === 'oauth.client_credentials.issue')).toBe(true);
  });
});

describe('OidcProvider', () => {
  it('validates OIDC tokens and refreshes JWKS on key rotation', async () => {
    const records: Array<{ action: string; event: unknown }> = [];
    const audit = { record: (action: string, event: unknown) => records.push({ action, event }) };

    const { OidcProvider } = await import('../../src/security/auth/OidcProvider');

    const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwkA = keyA.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const jwkB = keyB.publicKey.export({ format: 'jwk' }) as { n: string; e: string };

    const token = jwt.sign(
      { sub: 'oidc-user' },
      keyB.privateKey,
      { algorithm: 'RS256', keyid: 'kid-b', issuer: 'https://issuer.example', audience: 'idea-aud', expiresIn: '5m' }
    );

    let calls = 0;
    const provider = new OidcProvider({
      issuer: 'https://issuer.example',
      audience: 'idea-aud',
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
      logger: audit,
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: true, status: 200, json: async () => ({ keys: [{ kid: 'kid-a', kty: 'RSA', n: jwkA.n!, e: jwkA.e!, alg: 'RS256' }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ keys: [{ kid: 'kid-b', kty: 'RSA', n: jwkB.n!, e: jwkB.e!, alg: 'RS256' }] }) };
      },
      jwksRefreshMs: 60_000,
    });

    const payload = await provider.validateIdToken(token);
    expect(payload.sub).toBe('oidc-user');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(records.some((entry) => entry.action === 'oidc.jwks.refresh')).toBe(true);
    expect(records.some((entry) => entry.action === 'oidc.id_token.validate')).toBe(true);
  });
});
