import { ConnectionPool } from '../src/transport/pool';
import { ConnectionRateLimiter } from '../src/transport/middleware/rateLimit';

describe('ConnectionPool', () => {
  it('enforces the maximum number of connections per client', () => {
    const pool = new ConnectionPool({ maxConnectionsPerClient: 2 });

    const first = pool.acquire('agent-1');
    const second = pool.acquire('agent-1');
    const third = pool.acquire('agent-1');

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(pool.getConnectionCount('agent-1')).toBe(2);

    pool.release('agent-1', first.connectionId);
    expect(pool.getConnectionCount('agent-1')).toBe(1);
  });
});

describe('ConnectionRateLimiter', () => {
  it('blocks requests that exceed the configured window quota', () => {
    const limiter = new ConnectionRateLimiter({ windowMs: 10_000, maxRequests: 2 });

    expect(limiter.consume('agent-1').allowed).toBe(true);
    expect(limiter.consume('agent-1').allowed).toBe(true);

    const blocked = limiter.consume('agent-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});
