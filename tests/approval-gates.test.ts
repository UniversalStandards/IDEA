/**
 * tests/approval-gates.test.ts
 * Unit tests for src/policy/approval-gates.ts
 * Covers: approve, reject, timeout, duplicate decision rejection, async webhook flow.
 */

// Set env before any module imports
process.env['JWT_SECRET'] = 'test-secret-that-is-32-characters-long!!';
process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-characters!!';
process.env['NODE_ENV'] = 'test';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';
process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'] = 'true';

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

import { ApprovalGate } from '../src/policy/approval-gates';
import type { ApprovalRequest, ApprovalDecision } from '../src/policy/approval-gates';
import { RiskLevel } from '../src/types/index';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeGate(timeoutMs = 5000): ApprovalGate {
  return new ApprovalGate(timeoutMs);
}

// ─────────────────────────────────────────────────────────────────
// Approve flow
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — synchronous approve flow', () => {
  it('resolves with the approval request when approved via submitDecision', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestSync(
      'tool-dangerous',
      'delete-all',
      'user@example.com',
      RiskLevel.HIGH,
    );

    const pending = gate.pending();
    expect(pending).toHaveLength(1);
    const req = pending[0] as ApprovalRequest;
    expect(req.toolId).toBe('tool-dangerous');
    expect(req.action).toBe('delete-all');
    expect(req.actor).toBe('user@example.com');
    expect(req.riskLevel).toBe(RiskLevel.HIGH);
    expect(req.status).toBe('pending');
    expect(req.expiresAt).toBeDefined();

    const decision: ApprovalDecision = {
      requestId: req.requestId,
      decision: 'approved',
      decidedBy: 'admin@example.com',
      decidedAt: new Date().toISOString(),
    };
    const updated = gate.submitDecision(decision);

    expect(updated.status).toBe('approved');
    expect(updated.decision?.decidedBy).toBe('admin@example.com');

    const resolved = await requestPromise;
    expect(resolved.status).toBe('approved');
    expect(resolved.requestId).toBe(req.requestId);
  });

  it('resolves via convenience approve() wrapper', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestSync(
      'tool-risky',
      'execute',
      'agent-1',
      RiskLevel.CRITICAL,
    );

    const [pending] = gate.pending() as [ApprovalRequest];
    gate.approve(pending.requestId, 'approver');

    const resolved = await requestPromise;
    expect(resolved.status).toBe('approved');
  });

  it('auto-approves when a matching rule is registered', async () => {
    const gate = makeGate();
    gate.autoApprove('safe-tool', 'read');

    const req = await gate.requestSync('safe-tool', 'read', 'user', RiskLevel.LOW);
    expect(req.status).toBe('approved');
    expect(req.decision?.decidedBy).toBe('system:auto-approve');
  });
});

// ─────────────────────────────────────────────────────────────────
// Reject flow
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — synchronous reject flow', () => {
  it('rejects the promise when a rejection decision is submitted', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestSync(
      'tool-dangerous',
      'wipe-db',
      'user@example.com',
      RiskLevel.CRITICAL,
    );

    const [pending] = gate.pending() as [ApprovalRequest];
    gate.submitDecision({
      requestId: pending.requestId,
      decision: 'rejected',
      decidedBy: 'admin',
      decidedAt: new Date().toISOString(),
      reason: 'Not authorised',
    });

    await expect(requestPromise).rejects.toThrow('Not authorised');
  });

  it('rejects the promise via convenience deny() wrapper', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestSync(
      'tool',
      'act',
      'user',
      RiskLevel.MEDIUM,
    );

    const [pending] = gate.pending() as [ApprovalRequest];
    gate.deny(pending.requestId, 'admin', 'Policy violation');

    await expect(requestPromise).rejects.toThrow('Policy violation');
  });

  it('stores the rejection decision on the request object', () => {
    const gate = makeGate();

    void gate.requestSync('tool', 'act', 'user', RiskLevel.HIGH).catch(() => {/* handled */});

    const [pending] = gate.pending() as [ApprovalRequest];
    const updated = gate.deny(pending.requestId, 'admin', 'Denied');

    expect(updated.status).toBe('rejected');
    expect(updated.decision?.decision).toBe('rejected');
    expect(updated.decision?.decidedBy).toBe('admin');
    expect(updated.decision?.reason).toBe('Denied');
  });
});

// ─────────────────────────────────────────────────────────────────
// Timeout flow
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('auto-denies with timed_out status after timeout expires', async () => {
    const gate = makeGate(1000); // 1 second timeout

    const requestPromise = gate.requestSync('tool', 'act', 'user', RiskLevel.HIGH);

    jest.advanceTimersByTime(1100);

    await expect(requestPromise).rejects.toThrow('timed out');

    // The request should now have timed_out status
    const allRequests = gate.listAll();
    expect(allRequests).toHaveLength(1);
    expect(allRequests[0]!.status).toBe('timed_out');
  });

  it('does not resolve after timeout even if decision is submitted', async () => {
    const gate = makeGate(500);

    const requestPromise = gate.requestSync('tool', 'act', 'user', RiskLevel.HIGH);

    jest.advanceTimersByTime(600);

    await expect(requestPromise).rejects.toThrow('timed out');

    // Attempting to submit a decision after timeout should throw
    const [timedOut] = gate.listAll() as [ApprovalRequest];
    expect(() =>
      gate.submitDecision({
        requestId: timedOut.requestId,
        decision: 'approved',
        decidedBy: 'admin',
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow('already resolved');
  });

  it('expiresAt is set correctly in the future', async () => {
    const gate = makeGate(60_000); // 1 minute

    void gate.requestSync('tool', 'act', 'user', RiskLevel.LOW).catch(() => {/* handled */});

    const [pending] = gate.pending() as [ApprovalRequest];
    const expiresAt = new Date(pending.expiresAt).getTime();
    const now = Date.now();

    expect(expiresAt).toBeGreaterThan(now);
    // Clean up
    gate.deny(pending.requestId, 'admin', 'cleanup');
  });
});

// ─────────────────────────────────────────────────────────────────
// Duplicate decision rejection
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — duplicate decision rejection', () => {
  it('throws when submitDecision is called twice for the same request', () => {
    const gate = makeGate();

    void gate.requestSync('tool', 'act', 'user', RiskLevel.HIGH).catch(() => {/* handled */});

    const [pending] = gate.pending() as [ApprovalRequest];

    gate.submitDecision({
      requestId: pending.requestId,
      decision: 'approved',
      decidedBy: 'admin',
      decidedAt: new Date().toISOString(),
    });

    expect(() =>
      gate.submitDecision({
        requestId: pending.requestId,
        decision: 'rejected',
        decidedBy: 'admin2',
        decidedAt: new Date().toISOString(),
        reason: 'Second attempt',
      }),
    ).toThrow('already resolved');
  });

  it('throws when approve() is called after deny()', () => {
    const gate = makeGate();

    void gate.requestSync('tool', 'act', 'user', RiskLevel.MEDIUM).catch(() => {/* handled */});

    const [pending] = gate.pending() as [ApprovalRequest];
    gate.deny(pending.requestId, 'admin', 'Denied first');

    expect(() => gate.approve(pending.requestId, 'admin2')).toThrow('already resolved');
  });

  it('throws when decision is submitted for a non-existent requestId', () => {
    const gate = makeGate();

    expect(() =>
      gate.submitDecision({
        requestId: '00000000-0000-0000-0000-000000000000',
        decision: 'approved',
        decidedBy: 'admin',
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow('not found');
  });
});

// ─────────────────────────────────────────────────────────────────
// Asynchronous webhook flow
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — asynchronous webhook flow', () => {
  it('returns a pending request and resolves when decision is submitted', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestAsync(
      'tool-webhook',
      'deploy',
      'ci-bot',
      RiskLevel.HIGH,
    );

    const pending = gate.pending();
    expect(pending).toHaveLength(1);
    const req = pending[0] as ApprovalRequest;
    expect(req.status).toBe('pending');

    gate.approve(req.requestId, 'human-approver', 'LGTM');

    const resolved = await requestPromise;
    expect(resolved.status).toBe('approved');
    expect(resolved.decision?.decidedBy).toBe('human-approver');
  });

  it('rejects when async request is denied', async () => {
    const gate = makeGate();

    const requestPromise = gate.requestAsync('tool', 'act', 'bot', RiskLevel.CRITICAL);

    const [pending] = gate.pending() as [ApprovalRequest];
    gate.deny(pending.requestId, 'admin', 'Too risky for automation');

    await expect(requestPromise).rejects.toThrow('Too risky for automation');
  });
});

// ─────────────────────────────────────────────────────────────────
// ApprovalRequest shape validation
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — ApprovalRequest shape', () => {
  it('contains all required fields', () => {
    const gate = makeGate();

    void gate.requestSync('my-tool', 'my-action', 'alice', RiskLevel.MEDIUM, { key: 'value' }).catch(() => {/* handled */});

    const [pending] = gate.pending() as [ApprovalRequest];

    expect(pending.requestId).toBeDefined();
    expect(typeof pending.requestId).toBe('string');
    expect(pending.toolId).toBe('my-tool');
    expect(pending.action).toBe('my-action');
    expect(pending.actor).toBe('alice');
    expect(pending.riskLevel).toBe(RiskLevel.MEDIUM);
    expect(pending.expiresAt).toBeDefined();
    expect(pending.metadata).toEqual({ key: 'value' });
    expect(pending.status).toBe('pending');
    expect(pending.createdAt).toBeDefined();

    // cleanup
    gate.deny(pending.requestId, 'admin', 'cleanup');
  });
});

// ─────────────────────────────────────────────────────────────────
// Query helpers
// ─────────────────────────────────────────────────────────────────

describe('ApprovalGate — query helpers', () => {
  it('pending() returns only pending requests', () => {
    const gate = makeGate();

    void gate.requestSync('tool', 'a1', 'user', RiskLevel.LOW).catch(() => {/* handled */});
    void gate.requestSync('tool', 'a2', 'user', RiskLevel.LOW).catch(() => {/* handled */});

    const [first, second] = gate.pending() as [ApprovalRequest, ApprovalRequest];
    gate.approve(first.requestId, 'admin');

    expect(gate.pending()).toHaveLength(1);
    expect(gate.pending()[0]!.requestId).toBe(second.requestId);

    // cleanup
    gate.deny(second.requestId, 'admin', 'cleanup');
  });

  it('get() returns undefined for unknown id', () => {
    const gate = makeGate();
    expect(gate.get('nonexistent')).toBeUndefined();
  });

  it('listAll() returns all requests regardless of status', () => {
    const gate = makeGate();

    void gate.requestSync('t', 'a', 'u', RiskLevel.LOW).catch(() => {/* handled */});
    void gate.requestSync('t', 'b', 'u', RiskLevel.HIGH).catch(() => {/* handled */});

    const [first, second] = gate.pending() as [ApprovalRequest, ApprovalRequest];
    gate.approve(first.requestId, 'admin');

    expect(gate.listAll()).toHaveLength(2);

    // cleanup — clear the pending timer for the second request
    gate.deny(second.requestId, 'admin', 'cleanup');
  });
});
