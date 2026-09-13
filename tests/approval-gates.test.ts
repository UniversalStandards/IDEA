import { ApprovalGateManager } from '../src/policy/approval-gates';
import { ApprovalStatus } from '../src/types/index';

describe('ApprovalGateManager', () => {
  let gates: ApprovalGateManager;

  beforeEach(() => {
    gates = new ApprovalGateManager();
  });

  it('creates a pending approval request', () => {
    const req = gates.request('deploy-tool', 'execute', 'agent-1', 'high risk action');
    expect(req.status).toBe(ApprovalStatus.PENDING);
    expect(gates.listPending()).toHaveLength(1);
  });

  it('decide(true) approves a pending request', () => {
    const req = gates.request('deploy-tool', 'execute', 'agent-1', 'reason');
    const decided = gates.decide(req.id, true, 'human-admin', 'looks fine');
    expect(decided.status).toBe(ApprovalStatus.APPROVED);
    expect(decided.decidedBy).toBe('human-admin');
    expect(gates.listPending()).toHaveLength(0);
  });

  it('decide(false) rejects a pending request', () => {
    const req = gates.request('deploy-tool', 'execute', 'agent-1', 'reason');
    const decided = gates.decide(req.id, false, 'human-admin');
    expect(decided.status).toBe(ApprovalStatus.REJECTED);
  });

  it('throws when deciding on an already-decided request', () => {
    const req = gates.request('tool', 'action', 'agent-1', 'reason');
    gates.decide(req.id, true, 'admin');
    expect(() => gates.decide(req.id, false, 'admin')).toThrow();
  });

  it('throws when deciding on an unknown request id', () => {
    expect(() => gates.decide('nonexistent-id', true, 'admin')).toThrow();
  });

  it('waitForDecision resolves once decide() is called', async () => {
    const req = gates.request('tool', 'action', 'agent-1', 'reason');
    const waitPromise = gates.waitForDecision(req.id, 10_000);
    gates.decide(req.id, true, 'admin');
    const result = await waitPromise;
    expect(result.status).toBe(ApprovalStatus.APPROVED);
  });

  it('waitForDecision times out and marks the request TIMED_OUT', async () => {
    jest.useFakeTimers();
    const req = gates.request('tool', 'action', 'agent-1', 'reason');
    const waitPromise = gates.waitForDecision(req.id, 1000);
    jest.advanceTimersByTime(1001);
    const result = await waitPromise;
    expect(result.status).toBe(ApprovalStatus.TIMED_OUT);
    jest.useRealTimers();
  });

  it('get() returns undefined for an unknown id', () => {
    expect(gates.get('nope')).toBeUndefined();
  });
});
