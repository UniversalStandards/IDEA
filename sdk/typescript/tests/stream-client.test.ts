type StreamMessage = {
  readonly data: string;
  readonly lastEventId: string;
};

type EventSourceOptions = {
  readonly fetch?: typeof fetch;
};

type MockEventSourceInstance = {
  readonly url: string;
  readonly options: EventSourceOptions | undefined;
  onmessage: ((message: StreamMessage) => void) | null;
  onerror: (() => void) | null;
  close(): void;
};

const eventSourceInstances: MockEventSourceInstance[] = [];

jest.mock('eventsource', () => {
  return {
    EventSource: class {
      public onmessage: ((message: StreamMessage) => void) | null = null;
      public onerror: (() => void) | null = null;
      public readonly url: string;
      public readonly options: EventSourceOptions | undefined;

      public constructor(url: string, options?: EventSourceOptions) {
        this.url = url;
        this.options = options;
        eventSourceInstances.push(this as unknown as MockEventSourceInstance);
      }

      public close(): void {
        return;
      }
    },
  };
});

describe('StreamClient', () => {
  beforeEach(() => {
    eventSourceInstances.length = 0;
  });

  it('reconnects using Last-Event-ID and yields parsed events', async () => {
    const { HubClient } = await import('../src');
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const hub = new HubClient({
      baseUrl: 'https://hub.example.com',
      apiKey: 'api-key-1',
      fetchImpl: fetchMock,
    });

    const iterator = hub.stream('stream-1');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(eventSourceInstances).toHaveLength(1);
    const firstConnection = eventSourceInstances[0];
    expect(firstConnection).toBeDefined();

    const nextEvent = iterator.next();
    firstConnection?.onmessage?.({ data: '{"step":"done"}', lastEventId: 'evt-1' });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: {
        id: 'evt-1',
        event: 'message',
        data: { step: 'done' },
        raw: '{"step":"done"}',
      },
    });

    firstConnection?.onerror?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1100);
    });

    expect(eventSourceInstances).toHaveLength(2);
    const reconnectFetch = eventSourceInstances[1]?.options?.fetch;
    expect(reconnectFetch).toBeDefined();
    await reconnectFetch?.('https://hub.example.com/probe');
    const reconnectHeaders = (fetchMock.mock.calls.at(-1)?.[1]?.headers ?? {}) as Record<string, string>;
    expect(reconnectHeaders['last-event-id']).toBe('evt-1');

    await iterator.return?.();
    hub.close();
  });
});
