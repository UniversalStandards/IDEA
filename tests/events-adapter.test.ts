/**
 * tests/events-adapter.test.ts
 * End-to-end integration tests for src/adapters/events/index.ts.
 * Covers webhook signature verification, deduplication, SSE delivery, and payload validation.
 * Uses mock Express request/response objects — no real HTTP calls are made.
 */

// ── Environment setup (must precede all module imports) ───────────────────
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';

// ── Module mocks ──────────────────────────────────────────────────────────
jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

// Controllable config mock — each test can set WEBHOOK_SECRET / EVENT_DEDUP_WINDOW_MS
const mockConfig: { WEBHOOK_SECRET: string | undefined; EVENT_DEDUP_WINDOW_MS: number } = {
  WEBHOOK_SECRET: undefined,
  EVENT_DEDUP_WINDOW_MS: 300_000,
};
jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => mockConfig),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────
import type { Router } from 'express';
import { EventsAdapter } from '../src/adapters/events/index';
import { hmac } from '../src/security/crypto';

// ── Mock request / response helpers ──────────────────────────────────────

type MockReq = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  ip: string;
  on: jest.Mock;
};

type MockRes = {
  _statusCode: number;
  _body: unknown;
  _written: string[];
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  flushHeaders: jest.Mock;
};

function makeReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    method: 'POST',
    url: '/webhook',
    headers: {},
    body: {},
    ip: '127.0.0.1',
    on: jest.fn(),
    ...overrides,
  };
}

function makeRes(): MockRes {
  const res: MockRes = {
    _statusCode: 200,
    _body: null,
    _written: [],
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res._statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  res.write.mockImplementation((data: string) => {
    res._written.push(data);
    return true;
  });
  return res;
}

/**
 * Dispatch a request through an Express Router using its internal handle method.
 * Awaits a setImmediate tick to let the async route handler settle before returning.
 */
async function dispatch(router: Router, req: MockReq, res: MockRes): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal Express Router handle
  (router as any)(req, res, jest.fn());
  // Yield to the microtask + I/O queue so async route handlers complete
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Compute a valid HMAC-SHA256 hex signature over the JSON-serialised body. */
function sign(body: unknown, secret: string): string {
  return hmac(JSON.stringify(body), secret);
}

// ── Shared fixtures ───────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret-32-char-value!!';

const VALID_BODY = {
  type: 'deploy.completed',
  id: 'evt-fixture-001',
  payload: { service: 'api', version: '1.2.3' },
};

// ─────────────────────────────────────────────────────────────────────────
// 1. Webhook Signature Verification
// ─────────────────────────────────────────────────────────────────────────

describe('EventsAdapter — Webhook Signature Verification', () => {
  let adapter: EventsAdapter;
  let router: Router;

  beforeEach(() => {
    mockConfig.WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockConfig.EVENT_DEDUP_WINDOW_MS = 300_000;
    adapter = new EventsAdapter();
    router = adapter.buildRouter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('accepts a webhook with a valid HMAC-SHA256 signature → 202', async () => {
    const body = { ...VALID_BODY, id: 'evt-valid-sig-001' };
    const req = makeReq({
      body,
      headers: { 'x-webhook-signature': sign(body, WEBHOOK_SECRET) },
    });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(202);
    expect(res._body).toMatchObject({ status: 'accepted', eventId: 'evt-valid-sig-001' });
  });

  it('rejects a webhook with an invalid signature → 401', async () => {
    const body = { ...VALID_BODY, id: 'evt-bad-sig-001' };
    const req = makeReq({
      body,
      headers: { 'x-webhook-signature': 'deadbeefdeadbeef' },
    });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: expect.stringContaining('Invalid') });
  });

  it('does not emit an event when signature is invalid', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    adapter.on('deploy.completed', handler);

    const body = { ...VALID_BODY, id: 'evt-bad-sig-002' };
    const req = makeReq({
      body,
      headers: { 'x-webhook-signature': 'badsig' },
    });

    await dispatch(router, req, makeRes());

    // Yield additional time for any errant async emit
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a webhook when X-Webhook-Signature header is missing → 401', async () => {
    // No 'x-webhook-signature' in headers
    const req = makeReq({ body: VALID_BODY });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: expect.stringContaining('Missing') });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. No WEBHOOK_SECRET Configured
// ─────────────────────────────────────────────────────────────────────────

describe('EventsAdapter — No WEBHOOK_SECRET configured', () => {
  let adapter: EventsAdapter;
  let router: Router;

  beforeEach(() => {
    mockConfig.WEBHOOK_SECRET = undefined;
    mockConfig.EVENT_DEDUP_WINDOW_MS = 300_000;
    adapter = new EventsAdapter();
    router = adapter.buildRouter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('accepts any valid payload without a signature header → 202', async () => {
    const body = { type: 'test.event', id: 'evt-nosec-001' };
    const req = makeReq({ body }); // No signature header
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(202);
    expect(res._body).toMatchObject({ status: 'accepted', eventId: 'evt-nosec-001' });
  });

  it('accepts a payload even when an arbitrary signature header is present → 202', async () => {
    const body = { type: 'test.event', id: 'evt-nosec-002' };
    const req = makeReq({
      body,
      headers: { 'x-webhook-signature': 'arbitrary-ignored-value' },
    });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(202);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Deduplication
// ─────────────────────────────────────────────────────────────────────────

describe('EventsAdapter — Deduplication', () => {
  let adapter: EventsAdapter;
  let router: Router;

  beforeEach(() => {
    mockConfig.WEBHOOK_SECRET = undefined;
    mockConfig.EVENT_DEDUP_WINDOW_MS = 300_000;
    adapter = new EventsAdapter();
    router = adapter.buildRouter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('returns 200 { status: duplicate } for a repeated event.id within the window', async () => {
    const body = { type: 'test.event', id: 'dedup-evt-same' };

    const res1 = makeRes();
    const res2 = makeRes();

    await dispatch(router, makeReq({ body }), res1);
    await dispatch(router, makeReq({ body }), res2);

    expect(res1._statusCode).toBe(202);
    expect(res2._statusCode).toBe(200);
    expect(res2._body).toMatchObject({ status: 'duplicate', eventId: 'dedup-evt-same' });
  });

  it('does not invoke event handlers for a duplicate event', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    adapter.on('test.event', handler);

    const body = { type: 'test.event', id: 'dedup-handler-evt' };

    await dispatch(router, makeReq({ body }), makeRes());
    await dispatch(router, makeReq({ body }), makeRes());

    // Wait for any async emits to settle
    await new Promise<void>((r) => setTimeout(r, 50));

    // Handler must be called exactly once (first submission only)
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts a re-submitted event.id after the dedup window has expired', async () => {
    // Use a 1 ms window so the entry expires almost immediately
    mockConfig.EVENT_DEDUP_WINDOW_MS = 1;

    const evtA = { type: 'test.event', id: 'dedup-expire-A' };
    const evtB = { type: 'test.event', id: 'dedup-expire-B' };

    // First submission of A — accepted
    await dispatch(router, makeReq({ body: evtA }), makeRes());

    // Wait well beyond the 1 ms window
    await new Promise<void>((r) => setTimeout(r, 50));

    // Submit B: this triggers the pruning loop, which removes A (expired > 1 ms ago)
    await dispatch(router, makeReq({ body: evtB }), makeRes());

    // Re-submit A — should now be accepted since its cache entry was pruned
    const res = makeRes();
    await dispatch(router, makeReq({ body: evtA }), res);

    expect(res._statusCode).toBe(202);
    expect(res._body).toMatchObject({ status: 'accepted', eventId: 'dedup-expire-A' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. SSE Event Delivery
// ─────────────────────────────────────────────────────────────────────────

describe('EventsAdapter — SSE Event Delivery', () => {
  let adapter: EventsAdapter;
  let router: Router;

  beforeEach(() => {
    mockConfig.WEBHOOK_SECRET = undefined;
    mockConfig.EVENT_DEDUP_WINDOW_MS = 300_000;
    adapter = new EventsAdapter();
    router = adapter.buildRouter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('registers an SSE client on GET /stream and writes the connection frame', () => {
    const req = makeReq({ method: 'GET', url: '/stream' });
    const res = makeRes();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling router as middleware
    (router as any)(req, res, jest.fn());

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res._written).toContain(': connected\n\n');
    expect(adapter.sseClientCount).toBe(1);
  });

  it('delivers an accepted webhook event to connected SSE clients', async () => {
    // Connect an SSE client
    const sseReq = makeReq({ method: 'GET', url: '/stream' });
    const sseRes = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling router as middleware
    (router as any)(sseReq, sseRes, jest.fn());
    expect(adapter.sseClientCount).toBe(1);

    // Send a webhook event
    const body = { type: 'deploy.completed', id: 'sse-delivery-001', payload: { svc: 'api' } };
    await dispatch(router, makeReq({ body }), makeRes());

    // Allow the async emit to write to SSE clients
    await new Promise<void>((r) => setTimeout(r, 50));

    // Verify a data frame was written to the SSE client
    const dataFrames = sseRes._written.filter((w) => w.startsWith('data:'));
    expect(dataFrames).toHaveLength(1);

    const payload = JSON.parse(dataFrames[0]!.replace(/^data:\s*/, '').trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'deploy.completed', id: 'sse-delivery-001' });
  });

  it('removes the SSE client from the registry when its connection closes', () => {
    let closeHandler: (() => void) | undefined;

    const req = makeReq({
      method: 'GET',
      url: '/stream',
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      }),
    });
    const res = makeRes();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling router as middleware
    (router as any)(req, res, jest.fn());
    expect(adapter.sseClientCount).toBe(1);

    // Simulate the client disconnecting
    closeHandler?.();
    expect(adapter.sseClientCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Malformed / Invalid Payloads
// ─────────────────────────────────────────────────────────────────────────

describe('EventsAdapter — Malformed Payloads', () => {
  let adapter: EventsAdapter;
  let router: Router;

  beforeEach(() => {
    mockConfig.WEBHOOK_SECRET = undefined;
    mockConfig.EVENT_DEDUP_WINDOW_MS = 300_000;
    adapter = new EventsAdapter();
    router = adapter.buildRouter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('returns 400 with Zod details when the required type field is missing', async () => {
    const req = makeReq({ body: { id: 'bad-evt-001' } }); // Missing required 'type'
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toMatchObject({
      error: 'Invalid event payload',
      details: expect.arrayContaining([
        expect.objectContaining({ path: ['type'] }),
      ]),
    });
  });

  it('returns 400 for a completely empty body object', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toMatchObject({ error: 'Invalid event payload' });
  });

  it('returns 400 when type exceeds the maximum allowed length (255 chars)', async () => {
    const req = makeReq({ body: { type: 'x'.repeat(256) } });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toMatchObject({ error: 'Invalid event payload' });
  });

  it('returns 400 when type is an empty string', async () => {
    const req = makeReq({ body: { type: '' } });
    const res = makeRes();

    await dispatch(router, req, res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toMatchObject({ error: 'Invalid event payload' });
  });
});
