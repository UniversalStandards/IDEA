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
  readonly data: Record<string, unknown>;
  readonly timestamp: string;
}

export interface StreamMeta {
  readonly streamId: string;
  readonly protocol: 'sse' | 'websocket' | 'grpc' | 'http';
  readonly createdAt: string;
  readonly status: 'open' | 'closed' | 'errored';
}

export interface StreamChunk {
  readonly streamId: string;
  readonly sequence: number;
  readonly content: string;
  readonly timestamp: string;
  readonly isFinal?: boolean;
}

export interface StreamOptions {
  readonly protocol: StreamMeta['protocol'];
  readonly includeMetadata?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferedEvents?: number;
}
