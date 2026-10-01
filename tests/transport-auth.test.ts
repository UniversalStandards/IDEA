/**
 * tests/transport-auth.test.ts
 * Unit tests for src/transport/middleware/auth.ts — isTransportAuthorized()
 * is the shared gate for the SSE, WebSocket, and gRPC transports, all of
 * which route an authorized request straight into
 * runtimeManager.handleRequest() with full capability access. A
 * worker-session token (minted by adapters/upcloud-worker-factory for a
 * single browser/desktop session) is signed with the same JWT_SECRET as
 * every other bearer token this hub issues, so it must be explicitly
 * rejected here — not just at the Admin API — or it becomes a general
 * runtime-access credential.
 */

import jwt from 'jsonwebtoken';
import { isTransportAuthorized } from '../src/transport/middleware/auth';

const JWT_SECRET = 'test-secret-that-is-32-characters-long!!';

describe('isTransportAuthorized()', () => {
  it('returns false when no token is provided and auth is required', () => {
    expect(isTransportAuthorized({ config: { JWT_SECRET } })).toBe(false);
  });

  it('returns true when no token is provided and auth is not required', () => {
    expect(isTransportAuthorized({ config: { JWT_SECRET }, required: false })).toBe(true);
  });

  it('returns false for a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'someone' }, 'wrong-secret-that-is-very-long-padding!!');
    expect(isTransportAuthorized({ config: { JWT_SECRET }, token })).toBe(false);
  });

  it('returns true for an ordinary token with no worker-session scope', () => {
    const token = jwt.sign({ sub: 'agent-1' }, JWT_SECRET, { expiresIn: '1h' });
    expect(isTransportAuthorized({ config: { JWT_SECRET }, token })).toBe(true);
  });

  it('accepts the token via an Authorization: Bearer header', () => {
    const token = jwt.sign({ sub: 'agent-1' }, JWT_SECRET, { expiresIn: '1h' });
    expect(isTransportAuthorized({ config: { JWT_SECRET }, authorization: `Bearer ${token}` })).toBe(true);
  });

  it('rejects a worker-session-scoped token, even though it is validly signed', () => {
    const workerToken = jwt.sign(
      { sub: 'agent-1', scope: 'worker-session', sessionId: 'sess-abc', capabilities: ['browser'] },
      JWT_SECRET,
      { expiresIn: '15m' },
    );
    expect(isTransportAuthorized({ config: { JWT_SECRET }, token: workerToken })).toBe(false);
    expect(
      isTransportAuthorized({ config: { JWT_SECRET }, authorization: `Bearer ${workerToken}` }),
    ).toBe(false);
  });
});
