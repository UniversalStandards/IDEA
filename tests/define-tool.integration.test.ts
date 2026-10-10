/**
 * tests/define-tool.integration.test.ts
 * Verifies defineTool() against the REAL MCP SDK (McpServer + Client over an
 * in-memory transport). This is the guarantee the unit tests with a mocked
 * McpServer cannot give: the SDK still validates input against the Zod shape,
 * hands the *parsed* arguments to our handler, and lists the tool to clients.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { defineTool } from '../src/adapters/mcp/define-tool';

async function connectPair(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('defineTool() with the real MCP SDK', () => {
  let server: McpServer;
  let client: Client;
  const seen: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = new McpServer({ name: 'define-tool-test', version: '1.0.0' });

    defineTool(
      server,
      'add',
      'Add two integers',
      {
        a: z.number().int().describe('left operand'),
        b: z.number().int().describe('right operand'),
        label: z.string().optional(),
      },
      async (args) => {
        seen.push(args);
        return {
          content: [{ type: 'text' as const, text: String(args.a + args.b) }],
        };
      },
    );

    defineTool(server, 'ping', 'Takes no arguments', {}, async () => ({
      content: [{ type: 'text' as const, text: 'pong' }],
    }));

    client = await connectPair(server);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('lists the registered tools with their descriptions', async () => {
    const { tools } = await client.listTools();

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['add', 'ping']);
    expect(byName['add']?.description).toBe('Add two integers');
  });

  it('publishes a JSON schema derived from the Zod shape', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add');

    expect(add?.inputSchema.type).toBe('object');
    expect(Object.keys(add?.inputSchema.properties ?? {}).sort()).toEqual(['a', 'b', 'label']);
    expect(add?.inputSchema.required).toEqual(['a', 'b']);
  });

  it('invokes the handler with validated arguments and returns its result', async () => {
    const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '5' }]);
    expect(seen).toEqual([{ a: 2, b: 3 }]);
  });

  it('passes optional arguments through when supplied', async () => {
    await client.callTool({ name: 'add', arguments: { a: 1, b: 1, label: 'sum' } });

    expect(seen).toEqual([{ a: 1, b: 1, label: 'sum' }]);
  });

  /**
   * True when the SDK refuses the call — either as an `isError` tool result or
   * as a protocol-level rejection (the SDK has used both across versions).
   */
  async function isRefused(name: string, args: Record<string, unknown>): Promise<boolean> {
    try {
      const result = await client.callTool({ name, arguments: args });
      return result.isError === true;
    } catch {
      return true;
    }
  }

  it('rejects a wrongly-typed argument before the handler runs', async () => {
    await expect(isRefused('add', { a: 'two', b: 3 })).resolves.toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('rejects a non-integer for an int field before the handler runs', async () => {
    await expect(isRefused('add', { a: 1.5, b: 2 })).resolves.toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('rejects a call that omits a required argument before the handler runs', async () => {
    await expect(isRefused('add', { a: 1 })).resolves.toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('supports tools that take no arguments', async () => {
    const result = await client.callTool({ name: 'ping', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
  });
});
