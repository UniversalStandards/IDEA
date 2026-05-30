import { createHash } from 'crypto';

export interface DoomLoopSignature {
  agentId: string;
  toolName: string;
  inputHash: string;
}

export interface DoomLoopDetection {
  detected: boolean;
  signature: DoomLoopSignature;
}

export class DoomLoopDetector {
  private readonly histories = new Map<string, DoomLoopSignature[]>();

  constructor(private readonly repeatThreshold = 5) {}

  static hashInput(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input) ?? 'null').digest('hex');
  }

  recordStep(input: {
    workflowId: string;
    agentId: string;
    toolName: string;
    toolInput: unknown;
  }): DoomLoopDetection {
    const signature: DoomLoopSignature = {
      agentId: input.agentId,
      toolName: input.toolName,
      inputHash: DoomLoopDetector.hashInput(input.toolInput),
    };

    const history = this.histories.get(input.workflowId) ?? [];
    history.push(signature);

    if (history.length > this.repeatThreshold) {
      history.shift();
    }

    this.histories.set(input.workflowId, history);

    const detected =
      history.length === this.repeatThreshold
      && history.every(
        (entry) =>
          entry.agentId === signature.agentId
          && entry.toolName === signature.toolName
          && entry.inputHash === signature.inputHash,
      );

    return { detected, signature };
  }

  reset(workflowId: string): void {
    this.histories.delete(workflowId);
  }
}
