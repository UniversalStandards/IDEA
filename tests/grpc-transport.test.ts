import * as grpc from '@grpc/grpc-js';
import type { Config } from '../src/config';
import { ConnectionPool } from '../src/transport/pool';
import {
  GrpcTransport,
  createGrpcClientConstructor,
  type GrpcEnvelope,
  type GrpcResponseEnvelope,
} from '../src/transport/grpc';

type TransportClient = grpc.Client & {
  call(
    request: GrpcEnvelope,
    callback: (error: grpc.ServiceError | null, response: GrpcResponseEnvelope) => void,
  ): void;
  stream(request: GrpcEnvelope): grpc.ClientReadableStream<GrpcResponseEnvelope>;
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX_REQUESTS: 10,
    TRANSPORT_MAX_CONNECTIONS_PER_CLIENT: 2,
    GRPC_PORT: 0,
    JWT_SECRET: 'test-secret-that-is-32-characters-long!!',
    MCP_TRANSPORT: 'grpc',
    ...overrides,
  } as unknown as Config;
}

describe('GrpcTransport', () => {
  it('supports unary and server-streaming RPCs', async () => {
    const transport = new GrpcTransport({
      config: makeConfig(),
      connectionPool: new ConnectionPool({ maxConnectionsPerClient: 2 }),
      host: '127.0.0.1',
      port: 0,
      onMessage: async (payload: unknown): Promise<unknown> => ({ received: payload }),
      onStream: async (): Promise<unknown[]> => [{ index: 1 }, { index: 2 }],
    });

    await transport.initialize();
    await transport.start();

    const Client = createGrpcClientConstructor() as unknown as new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => TransportClient;
    const client = new Client(transport.getAddress(), grpc.credentials.createInsecure());

    const unaryResponse = await new Promise<GrpcResponseEnvelope>((resolve, reject) => {
      client.call({ clientId: 'agent-1', payload: { message: 'ping' } }, (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });

    const streamResponses = await new Promise<GrpcResponseEnvelope[]>((resolve, reject) => {
      const responses: GrpcResponseEnvelope[] = [];
      const stream = client.stream({ clientId: 'agent-1', payload: { stream: true } });
      stream.on('data', (message) => responses.push(message));
      stream.on('end', () => resolve(responses));
      stream.on('error', reject);
    });

    expect(unaryResponse.success).toBe(true);
    expect((unaryResponse.result as Record<string, unknown>)['received']).toEqual({ message: 'ping' });
    expect(streamResponses.map((message) => (message.result as Record<string, unknown>)['index'])).toEqual([1, 2]);

    client.close();
    await transport.stop();
  });
});
