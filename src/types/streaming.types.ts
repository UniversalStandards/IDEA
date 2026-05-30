export enum StreamEventType {
  TOKEN = 'token',
  TOOL_START = 'tool_start',
  TOOL_RESULT = 'tool_result',
  PROGRESS = 'progress',
  DONE = 'done',
  ERROR = 'error',
}

export interface StreamEvent {
  readonly streamId: string;
  readonly orgId: string;
  readonly eventType: StreamEventType;
  readonly sequence: number;
  readonly data: unknown;
  readonly timestamp: number;
}

export interface StreamMeta {
  readonly streamId: string;
  readonly orgId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSequence: number;
  readonly connected: boolean;
}
