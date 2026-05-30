import { randomUUID } from 'node:crypto';

export interface WsLikeConnection {
  send(data: string): void;
  on(event: 'message' | 'close', listener: (data?: unknown) => void): this;
  off?(event: 'message' | 'close', listener: (data?: unknown) => void): this;
}

export interface WsStreamMessage {
  readonly streamId: string;
  readonly orgId: string;
  readonly payload: unknown;
}

interface WsChunkEnvelope {
  readonly kind: 'chunk';
  readonly messageId: string;
  readonly streamId: string;
  readonly orgId: string;
  readonly index: number;
  readonly total: number;
  readonly payload: string;
}

interface WsMessageEnvelope {
  readonly kind: 'message';
  readonly messageId: string;
  readonly streamId: string;
  readonly orgId: string;
  readonly payload: string;
}

interface InflightReassembly {
  readonly streamId: string;
  readonly orgId: string;
  readonly total: number;
  readonly parts: Map<number, Buffer>;
}

export interface WsStreamHandlerOptions {
  readonly chunkSizeBytes?: number;
  readonly onMessage?: (message: WsStreamMessage) => void;
}

export class WsStreamHandler {
  private readonly chunkSizeBytes: number;
  private readonly onMessage: ((message: WsStreamMessage) => void) | undefined;
  private readonly inflight = new Map<WsLikeConnection, Map<string, InflightReassembly>>();

  constructor(options: WsStreamHandlerOptions = {}) {
    this.chunkSizeBytes = options.chunkSizeBytes ?? 16 * 1024;
    this.onMessage = options.onMessage;
  }

  attachConnection(connection: WsLikeConnection): () => void {
    const onMessage = (data?: unknown): void => {
      if (typeof data !== 'string') {
        return;
      }
      this.handleRawMessage(connection, data);
    };

    const onClose = (): void => {
      this.inflight.delete(connection);
    };

    connection.on('message', onMessage);
    connection.on('close', onClose);

    return () => {
      if (typeof connection.off === 'function') {
        connection.off('message', onMessage);
        connection.off('close', onClose);
      }
      this.inflight.delete(connection);
    };
  }

  send(connection: WsLikeConnection, message: WsStreamMessage): void {
    const messageId = randomUUID();
    const serializedPayload = JSON.stringify(message.payload);
    const payloadBuffer = Buffer.from(serializedPayload, 'utf8');

    if (payloadBuffer.length <= this.chunkSizeBytes) {
      const envelope: WsMessageEnvelope = {
        kind: 'message',
        messageId,
        streamId: message.streamId,
        orgId: message.orgId,
        payload: serializedPayload,
      };
      connection.send(JSON.stringify(envelope));
      return;
    }

    const total = Math.ceil(payloadBuffer.length / this.chunkSizeBytes);
    for (let index = 0; index < total; index += 1) {
      const start = index * this.chunkSizeBytes;
      const end = Math.min(start + this.chunkSizeBytes, payloadBuffer.length);
      const chunk = payloadBuffer.subarray(start, end).toString('base64');
      const envelope: WsChunkEnvelope = {
        kind: 'chunk',
        messageId,
        streamId: message.streamId,
        orgId: message.orgId,
        index,
        total,
        payload: chunk,
      };
      connection.send(JSON.stringify(envelope));
    }
  }

  private handleRawMessage(connection: WsLikeConnection, raw: string): void {
    const decoded = this.tryParseJson(raw);
    if (!decoded || typeof decoded !== 'object' || !('kind' in decoded)) {
      return;
    }

    if (decoded.kind === 'message') {
      const message = decoded as WsMessageEnvelope;
      const payload = this.tryParseJson(message.payload);
      if (payload === undefined) {
        return;
      }
      this.onMessage?.({ streamId: message.streamId, orgId: message.orgId, payload });
      return;
    }

    if (decoded.kind !== 'chunk') {
      return;
    }

    const chunk = decoded as WsChunkEnvelope;
    const connectionInflight = this.getInflight(connection);
    const existing =
      connectionInflight.get(chunk.messageId) ??
      {
        streamId: chunk.streamId,
        orgId: chunk.orgId,
        total: chunk.total,
        parts: new Map<number, Buffer>(),
      };

    existing.parts.set(chunk.index, Buffer.from(chunk.payload, 'base64'));
    connectionInflight.set(chunk.messageId, existing);

    if (existing.parts.size !== existing.total) {
      return;
    }

    const ordered: Buffer[] = [];
    for (let index = 0; index < existing.total; index += 1) {
      const part = existing.parts.get(index);
      if (!part) {
        return;
      }
      ordered.push(part);
    }

    connectionInflight.delete(chunk.messageId);
    const payloadJson = Buffer.concat(ordered).toString('utf8');
    const payload = this.tryParseJson(payloadJson);
    if (payload === undefined) {
      return;
    }

    this.onMessage?.({ streamId: existing.streamId, orgId: existing.orgId, payload });
  }

  private getInflight(connection: WsLikeConnection): Map<string, InflightReassembly> {
    let state = this.inflight.get(connection);
    if (!state) {
      state = new Map<string, InflightReassembly>();
      this.inflight.set(connection, state);
    }
    return state;
  }

  private tryParseJson(value: string): unknown | undefined {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
}
