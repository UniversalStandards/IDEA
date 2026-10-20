/**
 * tests/approval.test.ts
 * Unit tests for src/adapters/mcp/approval.ts — human-in-the-loop approval
 * resolution for MCP tool calls.
 */

jest.mock('../src/security/audit', () => ({ auditLog: { record: jest.fn() } }));
jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import {
  canonicalJson,
  obtainApproval,
  payloadFingerprint,
  pendingApprovalMessage,
  type ElicitationChannel,
} from '../src/adapters/mcp/approval';
import { approvalGates } from '../src/policy/approval-gates';
import { auditLog } from '../src/security/audit';
import { ApprovalStatus } from '../src/types/index';

function channel(
  supportsElicitation: boolean,
  answer?: () => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, boolean> }>,
): ElicitationChannel & { elicitInput: jest.Mock } {
  return {
    getClientCapabilities: () => (supportsElicitation ? { elicitation: {} } : {}),
    elicitInput: jest.fn(answer ?? (() => Promise.resolve({ action: 'accept' as const, content: { approve: true } }))),
  };
}

function input(overrides: Partial<Parameters<typeof obtainApproval>[0]> = {}): Parameters<typeof obtainApproval>[0] {
  return {
    channel: channel(false),
    toolId: 'official:memory',
    action: 'install',
    summary: 'Install memory',
    actor: 'mcp-client',
    autoApproved: new Set<string>(),
    timeoutMs: 1000,
    payload: { args: [] },
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('obtainApproval()', () => {
  it('approves tools on the operator allowlist and audits it', async () => {
    const outcome = await obtainApproval(input({ autoApproved: new Set(['official:memory']) }));
    expect(outcome).toEqual({ status: 'approved', via: 'operator-allowlist' });
    expect(auditLog.record).toHaveBeenCalledWith(
      'approval.auto',
      'operator:AUTO_APPROVE_TOOLS',
      'official:memory:install',
      'success',
      undefined,
      { actor: 'mcp-client' },
    );
  });

  it('creates a pending request when the client cannot elicit', async () => {
    const outcome = await obtainApproval(input());
    expect(outcome.status).toBe('pending');
    const id = (outcome as { approvalId: string }).approvalId;
    expect(approvalGates.get(id)?.status).toBe(ApprovalStatus.PENDING);
  });

  it('redeems an approved approvalId exactly once', async () => {
    const pending = await obtainApproval(input());
    const id = (pending as { approvalId: string }).approvalId;
    approvalGates.decide(id, true, 'operator');

    await expect(obtainApproval(input({ approvalId: id }))).resolves.toEqual({
      status: 'approved',
      via: 'approval-id',
      approvalId: id,
    });
    const replay = await obtainApproval(input({ approvalId: id }));
    expect(replay).toMatchObject({ status: 'rejected', reason: expect.stringContaining('single-use') });
  });

  it('keeps reporting pending for an undecided approvalId', async () => {
    const pending = await obtainApproval(input());
    const id = (pending as { approvalId: string }).approvalId;
    await expect(obtainApproval(input({ approvalId: id }))).resolves.toEqual({ status: 'pending', approvalId: id });
  });

  it('binds an approvalId to the exact payload it was approved for', async () => {
    const pending = await obtainApproval(input({ action: 'write_file', payload: { params: { path: '/data/a.txt' } } }));
    const id = (pending as { approvalId: string }).approvalId;
    approvalGates.decide(id, true, 'operator');

    const swapped = await obtainApproval(
      input({ action: 'write_file', approvalId: id, payload: { params: { path: '/etc/passwd' } } }),
    );
    expect(swapped).toMatchObject({ status: 'rejected', reason: expect.stringContaining('payload') });

    // Key order does not matter; the canonical payload does.
    const reordered = await obtainApproval(
      input({ action: 'write_file', approvalId: id, payload: { params: { path: '/data/a.txt' } } }),
    );
    expect(reordered).toMatchObject({ status: 'approved', via: 'approval-id' });
  });

  it.each([
    ['not_found', 'not found'],
    ['mismatch', 'different tool, action or payload'],
    ['rejected', 'rejected or timed out'],
  ])('explains a %s approvalId', async (kind, text) => {
    let id = '00000000-0000-4000-8000-000000000000';
    if (kind !== 'not_found') {
      const req = approvalGates.request(
        kind === 'mismatch' ? 'other:tool' : 'official:memory',
        'install',
        'x',
        'r',
        { binding: payloadFingerprint({ args: [] }) },
      );
      approvalGates.decide(req.id, kind !== 'rejected', 'operator');
      id = req.id;
    }
    const outcome = await obtainApproval(input({ approvalId: id }));
    expect(outcome).toMatchObject({ status: 'rejected', approvalId: id });
    expect((outcome as { reason: string }).reason).toContain(text);
  });

  it('approves through elicitation when the user accepts', async () => {
    const ch = channel(true);
    const outcome = await obtainApproval(input({ channel: ch, timeoutMs: 4321 }));
    expect(outcome).toMatchObject({ status: 'approved', via: 'elicitation' });
    const [params, options] = ch.elicitInput.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({ mode: 'form', message: 'Approval required: Install memory' });
    expect(options).toEqual({ timeout: 4321 });
    const id = (outcome as { approvalId: string }).approvalId;
    expect(approvalGates.get(id)).toMatchObject({ status: ApprovalStatus.APPROVED, decidedBy: 'mcp-client-user (elicitation)' });
  });

  it.each([
    ['decline', undefined],
    ['cancel', undefined],
    ['accept', { approve: false }],
  ] as const)('rejects when the user answers %s %j', async (action, content) => {
    const ch = channel(true, () => Promise.resolve({ action, ...(content ? { content } : {}) }));
    const outcome = await obtainApproval(input({ channel: ch }));
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'The user did not approve this action' });
    const id = (outcome as { approvalId: string }).approvalId;
    expect(approvalGates.get(id)?.status).toBe(ApprovalStatus.REJECTED);
  });

  it('leaves the request pending when elicitation fails', async () => {
    const ch = channel(true, () => Promise.reject(new Error('timeout')));
    const outcome = await obtainApproval(input({ channel: ch }));
    expect(outcome.status).toBe('pending');
  });

  it('treats a channel that throws on capability lookup as non-eliciting', async () => {
    const ch: ElicitationChannel = {
      getClientCapabilities: () => {
        throw new Error('not connected');
      },
      elicitInput: jest.fn(),
    };
    await expect(obtainApproval(input({ channel: ch }))).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('canonicalJson() / payloadFingerprint()', () => {
  it('sorts keys at every level and drops undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
  });

  it('fingerprints equal payloads identically regardless of key order', () => {
    expect(payloadFingerprint({ a: 1, b: 2 })).toBe(payloadFingerprint({ b: 2, a: 1 }));
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
    expect(payloadFingerprint({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('pendingApprovalMessage()', () => {
  it('tells the caller how to approve and retry', () => {
    const body = JSON.parse(pendingApprovalMessage({ approvalId: 'abc' }, 'install_tool')) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'approval_required', approvalId: 'abc', retry: { tool: 'install_tool', approvalId: 'abc' } });
    expect(JSON.stringify(body['approveWith'])).toContain('/app/dist/cli/admin.js approvals approve abc');
  });
});
