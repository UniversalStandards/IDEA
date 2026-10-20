/**
 * tests/stdio-transport.test.ts
 * StdioTransportAdapter: speaks MCP over the given streams and ends the
 * process lifecycle when the client closes stdin.
 */

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/adapters/mcp/index', () => ({
  MCPAdapter: jest.fn().mockImplementation(() => ({ connect: mockConnect, close: mockClose })),
}));
// Keep the test to the stdio adapter: the network transports and runtime are
// not exercised here.
jest.mock('../src/transport/http', () => ({ HttpTransport: jest.fn() }));
jest.mock('../src/transport/sse', () => ({ SseTransport: jest.fn() }));
jest.mock('../src/transport/websocket', () => ({ WsTransport: jest.fn() }));
jest.mock('../src/transport/grpc', () => ({ GrpcTransport: jest.fn() }));
jest.mock('../src/transport/streamable-http', () => ({ StreamableHttpTransport: jest.fn() }));
jest.mock('../src/core/runtime-manager', () => ({ runtimeManager: {} }));
jest.mock('../src/normalization/request-normalizer', () => ({ requestNormalizer: {} }));
jest.mock('../src/core/lifecycle', () => ({ lifecycle: { shutdown: jest.fn() } }));
jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { PassThrough } from 'stream';
import { StdioTransportAdapter } from '../src/transport/index';

beforeEach(() => jest.clearAllMocks());

describe('StdioTransportAdapter', () => {
  it('refuses to start before initialize()', async () => {
    const adapter = new StdioTransportAdapter(new PassThrough(), new PassThrough(), jest.fn());
    await expect(adapter.start()).rejects.toThrow('Stdio transport has not been initialized');
  });

  it('connects the MCP adapter and shuts down once when the client closes stdin', async () => {
    const stdin = new PassThrough();
    const onDisconnect = jest.fn().mockResolvedValue(undefined);
    const adapter = new StdioTransportAdapter(stdin, new PassThrough(), onDisconnect);

    await adapter.initialize();
    await adapter.start();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    stdin.end();
    stdin.emit('close');
    await new Promise((r) => setImmediate(r));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('MCP stdio client disconnected');
  });

  it('does not trigger a shutdown for stdin closing after stop()', async () => {
    const stdin = new PassThrough();
    const onDisconnect = jest.fn().mockResolvedValue(undefined);
    const adapter = new StdioTransportAdapter(stdin, new PassThrough(), onDisconnect);
    await adapter.initialize();
    await adapter.start();

    await adapter.stop();
    stdin.end();
    stdin.emit('close');
    await new Promise((r) => setImmediate(r));

    expect(mockClose).toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
