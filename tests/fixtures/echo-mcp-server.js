/*
 * tests/fixtures/echo-mcp-server.js
 * Minimal stdio MCP server used by downstream integration tests.
 * Plain CommonJS so it can be spawned with `node` without a TS toolchain.
 */
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo the given text', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool(
  'env',
  { description: 'Report selected environment variables', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          jwtSecret: process.env.JWT_SECRET ?? null,
          fixtureVar: process.env.FIXTURE_VAR ?? null,
          cwd: process.cwd(),
        }),
      },
    ],
  }),
);

server.registerTool(
  'fail',
  { description: 'Always fails', inputSchema: {}, annotations: { destructiveHint: true } },
  async () => ({ content: [{ type: 'text', text: 'fixture failure' }], isError: true }),
);

server.connect(new StdioServerTransport()).catch((err) => {
  process.stderr.write(`fixture failed: ${err}\n`);
  process.exit(1);
});
