/**
 * src/cli/smoke.ts
 * End-to-end MCP smoke test for a running hub, usable locally, in CI, and
 * inside the container image:
 *
 *   node dist/cli/smoke.js --stdio                       # spawn this build over stdio
 *   node dist/cli/smoke.js --stdio --install official:memory --approve
 *   node dist/cli/smoke.js --http http://127.0.0.1:3000/mcp --token "$MCP_AUTH_TOKEN"
 *
 * Steps: initialize → tools/list → get_hub_status → discover_capabilities.
 * With --install <toolId>: install_tool → list_capability_actions →
 * execute_capability (memory server: create_entities + read_graph) →
 * uninstall_tool. --approve makes this client advertise elicitation and
 * accept approval prompts, exercising the human-approval path end to end.
 *
 * Prints one JSON line per step to stdout; exits non-zero on the first failure.
 */

import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildInstallerEnv } from '../provisioning/runtime-registrar';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const EXPECTED_TOOLS = [
  'discover_capabilities',
  'install_tool',
  'uninstall_tool',
  'list_installed_tools',
  'list_capability_actions',
  'execute_capability',
  'get_hub_status',
  'manage_policy',
  'route_to_provider',
];

export interface SmokeOptions {
  readonly mode: 'stdio' | 'http';
  readonly url?: string;
  readonly token?: string;
  readonly install?: string;
  readonly approve: boolean;
  /** Keep the installed tool (skip uninstall) — e.g. to verify persistence. */
  readonly keep: boolean;
  /** Only assert that this tool is already installed (restored from state). */
  readonly expectInstalled?: string;
  readonly serverEntry: string;
  readonly timeoutMs: number;
}

export function parseArgs(argv: string[]): SmokeOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get('--http');
  const token = get('--token') ?? process.env['MCP_AUTH_TOKEN'];
  const install = get('--install');
  const mode = url !== undefined ? 'http' : 'stdio';
  return {
    mode,
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined && token !== '' ? { token } : {}),
    ...(install !== undefined ? { install } : {}),
    approve: argv.includes('--approve'),
    keep: argv.includes('--keep'),
    ...(get('--expect-installed') !== undefined ? { expectInstalled: get('--expect-installed') as string } : {}),
    serverEntry: get('--server') ?? path.resolve(__dirname, '..', 'index.js'),
    timeoutMs: Number.parseInt(get('--timeout') ?? '180000', 10),
  };
}

function emit(step: string, ok: boolean, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ step, ok, ...detail })}\n`);
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function json(result: CallToolResult): Record<string, unknown> {
  try {
    return JSON.parse(textOf(result)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
}

function buildTransport(opts: SmokeOptions): Transport {
  if (opts.mode === 'http') {
    if (opts.url === undefined) throw new Error('--http requires a URL');
    const http = new StreamableHTTPClientTransport(new URL(opts.url), {
      ...(opts.token !== undefined
        ? { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } }
        : {}),
    });
    // SDK class vs. its own Transport interface under exactOptionalPropertyTypes.
    return http as unknown as Transport;
  }
  const passthrough = [
    'NODE_ENV',
    'HUB_DATA_DIR',
    'AUTO_APPROVE_TOOLS',
    'REQUIRE_APPROVAL_FOR_HIGH_RISK_ACTIONS',
    'LOG_LEVEL',
    'LOG_FILE_ENABLED',
    'ENABLE_LOCAL_WORKSPACE_SCAN',
  ];
  // Base + proxy/CA + npm config so the spawned hub can install tools.
  const env: Record<string, string> = { ...buildInstallerEnv(), MCP_TRANSPORT: 'stdio' };
  for (const key of passthrough) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return new StdioClientTransport({
    command: process.execPath,
    args: [opts.serverEntry],
    env,
    stderr: 'ignore',
  });
}

export async function runSmoke(opts: SmokeOptions): Promise<void> {
  const client = new Client(
    { name: 'universal-standard-smoke', version: '1.0.0' },
    { capabilities: opts.approve ? { elicitation: {} } : {} },
  );
  if (opts.approve) {
    client.setRequestHandler(ElicitRequestSchema, () =>
      Promise.resolve({ action: 'accept' as const, content: { approve: true } }),
    );
  }

  const transport = buildTransport(opts);
  await client.connect(transport, { timeout: 30_000 });
  const server = client.getServerVersion();
  emit('initialize', true, { mode: opts.mode, server });

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    emit('tools/list', missing.length === 0, { count: names.length, missing });
    if (missing.length > 0) throw new Error(`missing tools: ${missing.join(', ')}`);

    const status = await call(client, 'get_hub_status', {}, opts.timeoutMs);
    emit('get_hub_status', status.isError !== true, { version: json(status)['version'] });
    if (status.isError === true) throw new Error(textOf(status));

    const discovered = await call(client, 'discover_capabilities', { query: 'memory', limit: 5 }, opts.timeoutMs);
    emit('discover_capabilities', discovered.isError !== true, { count: json(discovered)['count'] });
    if (discovered.isError === true) throw new Error(textOf(discovered));

    if (opts.expectInstalled !== undefined) {
      const listed = await call(client, 'list_installed_tools', {}, opts.timeoutMs);
      const ids = ((json(listed)['tools'] as Array<{ id: string }> | undefined) ?? []).map((t) => t.id);
      const present = ids.includes(opts.expectInstalled);
      emit('list_installed_tools', present, { installed: ids });
      if (!present) throw new Error(`${opts.expectInstalled} was not restored`);
      const actions = await call(client, 'list_capability_actions', { toolId: opts.expectInstalled }, opts.timeoutMs);
      emit('list_capability_actions', actions.isError !== true);
      if (actions.isError === true) throw new Error(textOf(actions));
    }

    if (opts.install === undefined) return;
    const toolId = opts.install;

    const installed = await call(client, 'install_tool', { toolId }, opts.timeoutMs);
    const installBody = json(installed);
    emit('install_tool', installed.isError !== true, {
      toolId,
      approvedVia: installBody['approvedVia'],
      actions: installBody['actions'],
      startupWarning: installBody['startupWarning'],
      ...(installed.isError === true ? { error: textOf(installed) } : {}),
    });
    if (installed.isError === true) throw new Error(textOf(installed));

    const actions = await call(client, 'list_capability_actions', { toolId }, opts.timeoutMs);
    const actionNames = ((json(actions)['actions'] as Array<{ name: string }> | undefined) ?? []).map((a) => a.name);
    emit('list_capability_actions', actions.isError !== true && actionNames.length > 0, { actions: actionNames });
    if (actions.isError === true || actionNames.length === 0) throw new Error(textOf(actions));

    if (actionNames.includes('create_entities') && actionNames.includes('read_graph')) {
      const created = await call(
        client,
        'execute_capability',
        {
          toolId,
          action: 'create_entities',
          params: {
            entities: [{ name: 'smoke-test', entityType: 'check', observations: ['hub end-to-end smoke test'] }],
          },
        },
        opts.timeoutMs,
      );
      emit('execute_capability:create_entities', created.isError !== true);
      if (created.isError === true) throw new Error(textOf(created));

      const graph = await call(client, 'execute_capability', { toolId, action: 'read_graph', params: {} }, opts.timeoutMs);
      const found = textOf(graph).includes('smoke-test');
      emit('execute_capability:read_graph', graph.isError !== true && found);
      if (graph.isError === true || !found) throw new Error(`read_graph did not return the created entity: ${textOf(graph)}`);
    }

    if (opts.keep) return;

    const removed = await call(client, 'uninstall_tool', { toolId }, opts.timeoutMs);
    emit('uninstall_tool', removed.isError !== true, removed.isError === true ? { error: textOf(removed) } : {});
    if (removed.isError === true) throw new Error(textOf(removed));
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  runSmoke(parseArgs(process.argv.slice(2))).then(
    () => {
      emit('result', true);
      process.exit(0);
    },
    (err: unknown) => {
      emit('result', false, { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    },
  );
}
