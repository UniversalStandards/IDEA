/**
 * src/adapters/mcp/approval.ts
 * Human-in-the-loop approval for high-risk MCP tool calls (install,
 * uninstall, write/delete/shell actions on installed tools, policy changes).
 *
 * Resolution order:
 *   1. Operator allowlist (AUTO_APPROVE_TOOLS)            → approved
 *   2. A caller-supplied approvalId that was approved for
 *      exactly this tool + action and not yet used         → approved
 *   3. MCP elicitation — the client asks its human user    → approved / rejected
 *   4. Otherwise a pending approval request is created and
 *      the caller is told how an operator can approve it   → pending
 *
 * The model never approves its own request: elicitation is answered by the
 * client's user, and approvalIds are decided out of band (admin API / CLI).
 */

import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { approvalGates } from '../../policy/approval-gates';
import { auditLog } from '../../security/audit';
import { createLogger } from '../../observability/logger';

const logger = createLogger('mcp-approval');

/** The slice of the SDK Server used for elicitation (eases testing). */
export interface ElicitationChannel {
  getClientCapabilities(): { elicitation?: object } | undefined;
  elicitInput(params: ElicitRequestFormParams, options?: { timeout?: number }): Promise<ElicitResult>;
}

export type ApprovalVia = 'operator-allowlist' | 'approval-id' | 'elicitation';

export type ApprovalOutcome =
  | { readonly status: 'approved'; readonly via: ApprovalVia; readonly approvalId?: string }
  | { readonly status: 'pending'; readonly approvalId: string }
  | { readonly status: 'rejected'; readonly reason: string; readonly approvalId?: string };

export interface ApprovalInput {
  readonly channel: ElicitationChannel;
  readonly toolId: string;
  readonly action: string;
  readonly summary: string;
  readonly actor: string;
  readonly autoApproved: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly approvalId?: string | undefined;
  readonly metadata?: Record<string, unknown>;
}

function supportsElicitation(channel: ElicitationChannel): boolean {
  try {
    return channel.getClientCapabilities()?.elicitation !== undefined;
  } catch {
    return false;
  }
}

export async function obtainApproval(input: ApprovalInput): Promise<ApprovalOutcome> {
  const { toolId, action, actor } = input;

  if (input.autoApproved.has(toolId)) {
    auditLog.record('approval.auto', 'operator:AUTO_APPROVE_TOOLS', `${toolId}:${action}`, 'success', undefined, {
      actor,
    });
    return { status: 'approved', via: 'operator-allowlist' };
  }

  if (input.approvalId !== undefined) {
    const consumed = approvalGates.consume(input.approvalId, toolId, action, actor);
    if (consumed.ok) {
      return { status: 'approved', via: 'approval-id', approvalId: input.approvalId };
    }
    if (consumed.reason === 'pending') {
      return { status: 'pending', approvalId: input.approvalId };
    }
    const reasons: Record<typeof consumed.reason, string> = {
      not_found: 'approvalId not found (approvals do not survive a hub restart)',
      mismatch: 'approvalId was issued for a different tool or action',
      rejected: 'the approval request was rejected or timed out',
      already_used: 'approvalId has already been used; approvals are single-use',
    };
    return { status: 'rejected', reason: reasons[consumed.reason], approvalId: input.approvalId };
  }

  const request = approvalGates.request(toolId, action, actor, input.summary, input.metadata);

  if (!supportsElicitation(input.channel)) {
    return { status: 'pending', approvalId: request.id };
  }

  try {
    const answer = await input.channel.elicitInput(
      {
        mode: 'form',
        message: `Approval required: ${input.summary}`,
        requestedSchema: {
          type: 'object',
          properties: {
            approve: {
              type: 'boolean',
              title: 'Approve',
              description: `Allow "${action}" on ${toolId}?`,
            },
          },
          required: ['approve'],
        },
      },
      { timeout: input.timeoutMs },
    );

    const approved = answer.action === 'accept' && answer.content?.['approve'] === true;
    approvalGates.decide(
      request.id,
      approved,
      'mcp-client-user (elicitation)',
      approved ? 'Approved in client' : `Not approved in client (${answer.action})`,
    );
    return approved
      ? { status: 'approved', via: 'elicitation', approvalId: request.id }
      : { status: 'rejected', reason: 'The user did not approve this action', approvalId: request.id };
  } catch (err) {
    // Elicitation failed or timed out — keep the request pending so an
    // operator can still approve it out of band.
    logger.warn('Elicitation failed; approval left pending', {
      approvalId: request.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { status: 'pending', approvalId: request.id };
  }
}

/** Human-readable guidance returned to the client for a pending approval. */
export function pendingApprovalMessage(outcome: { approvalId: string }, toolName: string): string {
  return JSON.stringify(
    {
      status: 'approval_required',
      approvalId: outcome.approvalId,
      message:
        'This action needs human approval. An operator can approve it, then call this tool again with the same arguments plus approvalId.',
      approveWith: [
        `docker exec <hub-container> node /app/dist/cli/admin.js approvals approve ${outcome.approvalId}`,
        `POST /admin/approvals/${outcome.approvalId}/decide  {"approved": true}  (admin JWT required)`,
      ],
      retry: { tool: toolName, approvalId: outcome.approvalId },
    },
    null,
    2,
  );
}
