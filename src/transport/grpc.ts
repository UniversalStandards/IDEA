import * as grpc from '@grpc/grpc-js';
import type { Config } from '../config';
import { createLogger } from '../observability/logger';
import type { ITransport } from './index';
import type { ConnectionPool } from './pool';
import { ConnectionRateLimiter } from './middleware/rateLimit';
import { isTransportAuthorized } from './middleware/auth';

const logger = createLogger('grpc-transport');
const DEFAULT_GRPC_PORT = 50_051;

export interface GrpcEnvelope {
  readonly clientId?: string;
  readonly authorization?: string;
  readonly payload?: unknown;
}

export interface GrpcResponseEnvelope {
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface GrpcTransportOptions {
  readonly config: Pick<Config, 'JWT_SECRET' | 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX_REQUESTS'>;
  readonly connectionPool: ConnectionPool;
  readonly onMessage: (payload: unknown) => Promise<unknown>;
  readonly onStream?: (payload: unknown) => Promise<Iterable<unknown> | AsyncIterable<unknown> | unknown>;
  readonly host?: string;
  readonly port?: number;
  readonly rateLimiter?: ConnectionRateLimiter;
}

export const transportServiceDefinition: grpc.ServiceDefinition = {
  call: {
    path: '/transport.TransportService/Call',
    requestStream: false,
    responseStream: false,
    requestSerialize: serializeJson,
    requestDeserialize: deserializeJson,
    responseSerialize: serializeJson,
    responseDeserialize: deserializeJson,
  },
  stream: {
    path: '/transport.TransportService/Stream',
    requestStream: false,
    responseStream: true,
    requestSerialize: serializeJson,
    requestDeserialize: deserializeJson,
    responseSerialize: serializeJson,
    responseDeserialize: deserializeJson,
  },
};

export class GrpcTransport implements ITransport {
  readonly name = 'grpc' as const;
  private readonly server = new grpc.Server();
  private readonly host: string;
  private readonly port: number;
  private startedAddress: string | undefined;
  private readonly rateLimiter: ConnectionRateLimiter;

  constructor(private readonly options: GrpcTransportOptions) {
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? DEFAULT_GRPC_PORT;
    this.rateLimiter =
      options.rateLimiter ??
      new ConnectionRateLimiter({
        windowMs: options.config.RATE_LIMIT_WINDOW_MS,
        maxRequests: options.config.RATE_LIMIT_MAX_REQUESTS,
      });
  }

  async initialize(): Promise<void> {
    const implementation: grpc.UntypedServiceImplementation = {
      call: (
        call: grpc.ServerUnaryCall<GrpcEnvelope, GrpcResponseEnvelope>,
        callback: grpc.sendUnaryData<GrpcResponseEnvelope>,
      ) => {
        void this.handleUnary(call, callback);
      },
      stream: (call: grpc.ServerWritableStream<GrpcEnvelope, GrpcResponseEnvelope>) => {
        void this.handleStream(call);
      },
    };

    this.server.addService(transportServiceDefinition, implementation);
  }

  async start(): Promise<void> {
    if (this.startedAddress) {
      return;
    }

    const requestedAddress = `${this.host}:${this.port}`;
    const boundPort = await new Promise<number>((resolve, reject) => {
      this.server.bindAsync(
        requestedAddress,
        grpc.ServerCredentials.createInsecure(),
        (err, actualPort) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(actualPort);
        },
      );
    });
    this.server.start();
    this.startedAddress = `${this.host}:${boundPort}`;
    logger.info('gRPC transport ready', { address: this.startedAddress });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.tryShutdown(() => resolve());
    });
    this.startedAddress = undefined;
  }

  getAddress(): string {
    if (!this.startedAddress) {
      throw new Error('gRPC transport has not been started');
    }
    return this.startedAddress;
  }

  private async handleUnary(
    call: grpc.ServerUnaryCall<GrpcEnvelope, GrpcResponseEnvelope>,
    callback: grpc.sendUnaryData<GrpcResponseEnvelope>,
  ): Promise<void> {
    const clientId = call.request.clientId ?? call.getPeer();
    const release = this.acquireClient(clientId);
    if (!release) {
      callback(null, { success: false, error: 'Connection limit exceeded' });
      return;
    }

    try {
      this.assertAuthorized(call.request.authorization);
      this.assertRateLimit(clientId);
      const result = await this.options.onMessage(call.request.payload);
      callback(null, { success: true, result });
    } catch (err) {
      callback(null, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      release();
    }
  }

  private async handleStream(
    call: grpc.ServerWritableStream<GrpcEnvelope, GrpcResponseEnvelope>,
  ): Promise<void> {
    const clientId = call.request.clientId ?? call.getPeer();
    const release = this.acquireClient(clientId);
    if (!release) {
      call.write({ success: false, error: 'Connection limit exceeded' });
      call.end();
      return;
    }

    try {
      this.assertAuthorized(call.request.authorization);
      this.assertRateLimit(clientId);
      const source = this.options.onStream
        ? await this.options.onStream(call.request.payload)
        : await this.options.onMessage(call.request.payload);

      for await (const chunk of toAsyncIterable(source)) {
        call.write({ success: true, result: chunk });
      }
    } catch (err) {
      call.write({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      release();
      call.end();
    }
  }

  private acquireClient(clientId: string): (() => void) | undefined {
    const lease = this.options.connectionPool.acquire(clientId);
    if (!lease.allowed) {
      return undefined;
    }
    return () => this.options.connectionPool.release(clientId, lease.connectionId);
  }

  private assertAuthorized(authorization?: string): void {
    if (
      !isTransportAuthorized({
        authorization,
        config: this.options.config,
      })
    ) {
      throw new Error('Unauthorized transport request');
    }
  }

  private assertRateLimit(clientId: string): void {
    const decision = this.rateLimiter.consume(clientId);
    if (!decision.allowed) {
      throw new Error('Rate limit exceeded');
    }
  }
}

export function createGrpcClientConstructor(): grpc.ServiceClientConstructor {
  return grpc.makeGenericClientConstructor(
    transportServiceDefinition,
    'TransportService',
  ) as grpc.ServiceClientConstructor;
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value ?? null), 'utf8');
}

function deserializeJson(buffer: Buffer): unknown {
  return JSON.parse(buffer.toString('utf8'));
}

async function* toAsyncIterable(
  source: Iterable<unknown> | AsyncIterable<unknown> | unknown,
): AsyncIterable<unknown> {
  if (isAsyncIterable(source)) {
    yield* source;
    return;
  }

  if (isIterable(source)) {
    yield* source;
    return;
  }

  yield source;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}
