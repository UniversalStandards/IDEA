import { EventSource } from 'eventsource';
import type { HttpClient } from '../http';

export interface StreamEvent {
  readonly id?: string;
  readonly event: string;
  readonly data: unknown;
  readonly raw: string;
}

interface QueueItem {
  readonly value: StreamEvent;
}

export class StreamClient {
  private readonly http: HttpClient;

  public constructor(http: HttpClient) {
    this.http = http;
  }

  public subscribe(streamId: string): AsyncIterableIterator<StreamEvent> {
    const queue: QueueItem[] = [];
    const waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];

    let closed = false;
    let eventSource: EventSource | undefined;
    let lastEventId: string | undefined;

    const push = (event: StreamEvent): void => {
      if (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ value: event, done: false });
        }
        return;
      }

      queue.push({ value: event });
    };

    const reconnect = async (): Promise<void> => {
      if (closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      });

      if (closed) {
        return;
      }

      await connect();
    };

    const connect = async (): Promise<void> => {
      const headers = await this.http.getAuthHeaders();
      if (lastEventId) {
        headers['last-event-id'] = lastEventId;
      }

      const url = `${this.http.getBaseUrl()}/streams/${encodeURIComponent(streamId)}`;
      const streamFetch: typeof fetch = (input, init) => {
        const existingHeaders = (init?.headers ?? {}) as Record<string, string>;
        return this.http.getFetch()(input, {
          ...init,
          headers: {
            ...existingHeaders,
            ...headers,
          },
        });
      };

      eventSource = new EventSource(url, {
        fetch: streamFetch,
      });

      eventSource.onmessage = (message) => {
        lastEventId = message.lastEventId || lastEventId;
        const raw = String(message.data ?? '');

        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = raw;
        }

        const event: StreamEvent = {
          event: 'message',
          data: parsed,
          raw,
          ...(message.lastEventId ? { id: message.lastEventId } : {}),
        };

        push(event);
      };

      eventSource.onerror = () => {
        eventSource?.close();
        void reconnect();
      };
    };

    void connect();

    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
        return this;
      },
      async next(): Promise<IteratorResult<StreamEvent>> {
        if (queue.length > 0) {
          const item = queue.shift();
          return item ? { value: item.value, done: false } : { value: undefined, done: true };
        }

        if (closed) {
          return { value: undefined, done: true };
        }

        return new Promise<IteratorResult<StreamEvent>>((resolve) => {
          waiters.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<StreamEvent>> {
        closed = true;
        eventSource?.close();
        for (const waiter of waiters) {
          waiter({ value: undefined, done: true });
        }
        waiters.length = 0;
        return { value: undefined, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<StreamEvent>> {
        closed = true;
        eventSource?.close();
        throw error;
      },
    };
  }
}
