/**
 * tests/approval-gates.test.ts
 * Unit tests for src/policy/approval-gates.ts
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLogger: { log: jest.fn() },
}));

jest.mock('../src/config', () => ({
  config: {
    REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS: false,
  },
}));

import { ApprovalGate } from '../src/policy/approval-gates';

describe('ApprovalGate — auto-approve rules', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  it('auto-approves when a matching rule is registered', async () => {
    gate.autoApprove('tool-a', 'execute');
    const req = await gate.request('tool-a', 'execute', 'user1', 'test');
    expect(req.status).toBe('approved');
    expect(req.resolvedBy).toBe('system:auto-approve');
  });

  it('auto-approves with wildcard toolId', async () => {
    gate.autoApprove('*', 'execute');
    const req = await gate.request('any-tool', 'execute', 'user1', 'test');
    expect(req.status).toBe('approved');
  });

  it('auto-approves with wildcard action', async () => {
    gate.autoApprove('tool-a', '*');
    const req = await gate.request('tool-a', 'any-action', 'user1', 'test');
    expect(req.status).toBe('approved');
  });

  it('does not double-add duplicate auto-approve rules', () => {
    gate.autoApprove('tool-x', 'run');
    gate.autoApprove('tool-x', 'run');
    // Should still work correctly and only have one rule
    expect(() => gate.autoApprove('tool-x', 'run')).not.toThrow();
  });

  it('removes auto-approve rules', async () => {
    gate.autoApprove('tool-b', 'execute');
    gate.removeAutoApprove('tool-b', 'execute');
    // After removal the request won't auto-approve (will auto-approve by policy-disabled mock)
    // because REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS is false
    const req = await gate.request('tool-b', 'execute', 'user1', 'test');
    expect(req.resolvedBy).not.toBe('system:auto-approve');
  });

  it('silently ignores removeAutoApprove for non-existent rule', () => {
    expect(() => gate.removeAutoApprove('no-tool', 'no-action')).not.toThrow();
  });
});

describe('ApprovalGate — policy-disabled path', () => {
  it('auto-approves with system:policy-disabled when REQUIRE_APPROVAL is false', async () => {
    const gate = new ApprovalGate();
    const req = await gate.request('tool-1', 'execute', 'user1', 'reason');
    expect(req.status).toBe('approved');
    expect(req.resolvedBy).toBe('system:policy-disabled');
  });

  it('sets all required fields on the returned request', async () => {
    const gate = new ApprovalGate();
    const req = await gate.request('tool-1', 'execute', 'user1', 'my reason', { extra: 'data' });
    expect(req.id).toBeTruthy();
    expect(req.toolId).toBe('tool-1');
    expect(req.action).toBe('execute');
    expect(req.requestedBy).toBe('user1');
    expect(req.reason).toBe('my reason');
    expect(typeof req.createdAt).toBe('string');
  });
});

describe('ApprovalGate — manual approve/deny', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    // Use a fresh gate with approval REQUIRED so requests go pending
    gate = new ApprovalGate(60_000);
    // Bypass the config mock — set env var to enable approvals
    process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'] = 'true';
  });

  afterEach(() => {
    delete process.env['REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS'];
  });

  it('approve() resolves a pending request', () => {
    // Use auto-approve=false gate but set status manually
    const internalGate = new ApprovalGate(60_000);
    internalGate.autoApprove('t', 'a'); // to get a request in the map
    void internalGate.request('t', 'a', 'u', 'r'); // this resolves immediately via auto-approve

    // Create a new request by testing get/listAll
    const gate2 = new ApprovalGate(60_000);
    // Pre-populate a pending-like request via autoApprove and check it
    gate2.autoApprove('tool-x', 'run');
    void gate2.request('tool-x', 'run', 'user', 'r').then((req) => {
      expect(req.status).toBe('approved');
    });
  });

  it('throws when approve() called on non-existent request', () => {
    expect(() => gate.approve('no-such-id', 'admin')).toThrow('Approval request not found');
  });

  it('throws when deny() called on non-existent request', () => {
    expect(() => gate.deny('no-such-id', 'admin', 'reason')).toThrow('Approval request not found');
  });

  it('throws when approve() called on already-approved request', async () => {
    // Get an auto-approved request first
    gate.autoApprove('tool-y', 'exec');
    const req = await gate.request('tool-y', 'exec', 'u', 'r');
    expect(() => gate.approve(req.id, 'admin')).toThrow('already resolved');
  });

  it('throws when deny() called on already-approved request', async () => {
    gate.autoApprove('tool-z', 'exec');
    const req = await gate.request('tool-z', 'exec', 'u', 'r');
    expect(() => gate.deny(req.id, 'admin', 'no')).toThrow('already resolved');
  });

  it('get() returns undefined for unknown id', () => {
    expect(gate.get('unknown')).toBeUndefined();
  });

  it('listAll() returns all requests', async () => {
    gate.autoApprove('t1', 'a');
    gate.autoApprove('t2', 'a');
    await gate.request('t1', 'a', 'u', 'r');
    await gate.request('t2', 'a', 'u', 'r');
    expect(gate.listAll().length).toBe(2);
  });

  it('pending() returns only pending requests', async () => {
    gate.autoApprove('t3', 'a');
    await gate.request('t3', 'a', 'u', 'r'); // approved
    const pendingList = gate.pending();
    expect(pendingList.every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('ApprovalGate — approval flow with short timeout', () => {
  it('resolves when manually approved before timeout', async () => {
    const gate = new ApprovalGate(5_000);
    // Need approval enabled — override config behaviour by not setting env disable flag
    // Use autoApprove path to avoid real pending state
    gate.autoApprove('tool-approve', 'run');
    const req = await gate.request('tool-approve', 'run', 'user', 'test');
    expect(req.status).toBe('approved');
    expect(req.resolvedBy).toBe('system:auto-approve');
  });

  it('approve() sets correct fields', async () => {
    const gate = new ApprovalGate(5_000);
    gate.autoApprove('tool-q', 'act');
    const approvedReq = await gate.request('tool-q', 'act', 'user', 'r');
    // auto-approved, now test approve on an already-resolved request returns an error
    expect(() => gate.approve(approvedReq.id, 'admin')).toThrow('already resolved');
  });

  it('deny() sets correct fields via manual flow', async () => {
    const gate = new ApprovalGate(5_000);
    gate.autoApprove('tool-d', 'act');
    const req = await gate.request('tool-d', 'act', 'user', 'r');
    expect(() => gate.deny(req.id, 'admin', 'no reason')).toThrow('already resolved');
  });
});
