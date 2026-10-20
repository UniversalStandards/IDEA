/**
 * src/adapters/mcp/index.ts
 * The hub's MCP tool surface. One MCPAdapter (one McpServer) is created per
 * MCP session — a stdio process or a Streamable HTTP session — while the
 * installed tools and their downstream connections are shared process-wide.
 *
 * Tool lifecycle exposed to clients:
 *   discover_capabilities → install_tool → list_capability_actions →
 *   execute_capability → uninstall_tool
 *
 * High-risk operations go through human approval (see ./approval.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { obtainApproval, pendingApprovalMessage, type ApprovalOutcome, type ElicitationChannel } from './approval';
import { DownstreamError, getDownstreamClients, type DownstreamClientManager } from './downstream';
import { getServiceVersion } from '../../version';
import { config, getAutoApprovedTools } from '../../config';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { registryManager } from '../../discovery/registry-manager';
import { installer } from '../../provisioning/installer';
import { runtimeRegistrar } from '../../provisioning/runtime-registrar';
import { policyEngine } from '../../policy/policy-engine';
import { compileDeclarativePolicy, PROTECTED_POLICY_IDS } from '../../policy/declarative-policy';
import { providerRouter } from '../../routing/provider-router';

const logger = createLogger('mcp-adapter');

const ACTOR = 'mcp-client';
const POLICY_RESOURCE = 'hub:policy';

export interface MCPAdapterOptions {
  /** Override the elicitation channel (defaults to this session's server). */
  readonly approvalChannel?: ElicitationChannel;
  /** Override the shared downstream connection manager. */
  readonly downstream?: DownstreamClientManager;
}

function text(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function environment(): string {
  return process.env['NODE_ENV'] ?? 'development';
}

function readSetting<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export class MCPAdapter {
  private readonly server: McpServer;
  private readonly approvalChannel: ElicitationChannel;
  private readonly downstreamOverride: DownstreamClientManager | undefined;

  constructor(options: MCPAdapterOptions = {}) {
    this.server = new McpServer(
      { name: 'Universal Standard MCP Server', version: getServiceVersion() },
      {
        instructions:
          'Universal Standard MCP Server is an MCP hub. Use discover_capabilities to find MCP servers, ' +
          'install_tool to provision one, list_capability_actions to see its tools, and execute_capability ' +
          'to call them. High-risk actions require human approval; when a result says approval_required, ' +
          'ask an operator to approve and retry with the returned approvalId.',
      },
    );
    this.approvalChannel = options.approvalChannel ?? (this.server.server as unknown as ElicitationChannel);
    this.downstreamOverride = options.downstream;

    this.registerTools();
    logger.debug('MCP adapter initialized');
  }

  async connect(transport: Parameters<McpServer['connect']>[0]): Promise<void> {
    await this.server.connect(transport);
    logger.info('MCP adapter connected to transport');
  }

  /** Close this session's server and its transport. */
  async close(): Promise<void> {
    await this.server.close();
  }

  getServer(): McpServer {
    return this.server;
  }

  private downstream(): DownstreamClientManager {
    return this.downstreamOverride ?? getDownstreamClients();
  }

  private approve(
    toolId: string,
    action: string,
    summary: string,
    approvalId: string | undefined,
    metadata?: Record<string, unknown>,
  ): Promise<ApprovalOutcome> {
    return obtainApproval({
      channel: this.approvalChannel,
      toolId,
      action,
      summary,
      actor: ACTOR,
      autoApproved: readSetting(() => getAutoApprovedTools(config), new Set<string>()),
      timeoutMs: readSetting(() => config.APPROVAL_ELICITATION_TIMEOUT_MS, 120_000),
      approvalId,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  /** Map a non-approved outcome to a tool result; undefined means approved. */
  private approvalBlock(outcome: ApprovalOutcome, toolName: string): CallToolResult | undefined {
    if (outcome.status === 'approved') return undefined;
    if (outcome.status === 'pending') return errorResult(pendingApprovalMessage(outcome, toolName));
    return errorResult(`Approval rejected: ${outcome.reason}`);
  }

  private registerTools(): void {
    // ── 1. discover_capabilities ──────────────────────────────────────────
    defineTool(
      this.server,
      'discover_capabilities',
      'Search the configured registries (official MCP registry, GitHub, enterprise catalog, local workspace) for MCP servers matching a query',
      {
        query: z.string().min(1).max(500).describe('Search query for capabilities or tools'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return (default 20)'),
      },
      async (args) => {
        try {
          const results = await registryManager.search({ query: args.query, limit: args.limit ?? 20 });
          metrics.increment('mcp_tool_calls_total', { tool: 'discover_capabilities' });
          return text({
            tools: results.map((t) => ({
              ...t,
              installed: installer.isInstalled(t.id),
            })),
            count: results.length,
          });
        } catch (err) {
          logger.error('discover_capabilities failed', { err: errorMessage(err) });
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Discover MCP servers', readOnlyHint: true, openWorldHint: true },
    );

    // ── 2. install_tool ───────────────────────────────────────────────────
    defineTool(
      this.server,
      'install_tool',
      'Install an MCP server through the governed pipeline (policy, trust, human approval, npm install, registration) and verify it starts',
      {
        toolId: z.string().min(1).describe('Tool ID from discover_capabilities (e.g. "official:memory")'),
        args: z
          .array(z.string().max(4096))
          .max(32)
          .optional()
          .describe('Extra launch arguments, e.g. allowed directories for the filesystem server'),
        approvalId: z
          .string()
          .uuid()
          .optional()
          .describe('Approval ID from a previous approval_required response, once an operator approved it'),
      },
      async (args) => {
        try {
          const tool = await registryManager.getById(args.toolId);
          if (!tool) {
            return errorResult(`Tool not found: ${args.toolId}`);
          }

          if (installer.isInstalled(tool.id)) {
            const existing = installer.getInstallResult(tool.id);
            return text({
              success: true,
              alreadyInstalled: true,
              toolId: tool.id,
              installedAt: existing?.installedAt,
              path: existing?.path,
            });
          }

          const assessment = installer.assess(tool, ACTOR);
          if (assessment.denied !== undefined) {
            return errorResult(assessment.denied);
          }

          let approvedVia: string | undefined;
          if (assessment.requiresApproval) {
            const outcome = await this.approve(
              tool.id,
              'install',
              `Install ${tool.name}@${tool.version} from ${tool.source} (trust ${assessment.trustScore}/${assessment.minimumTrust} required)`,
              args.approvalId,
              { trustScore: assessment.trustScore, installCommand: tool.installCommand },
            );
            const blocked = this.approvalBlock(outcome, 'install_tool');
            if (blocked) return blocked;
            approvedVia = outcome.status === 'approved' ? outcome.via : undefined;
          }

          const result = await installer.install(tool, {
            preApproved: assessment.requiresApproval,
            actor: ACTOR,
            ...(args.args !== undefined ? { args: args.args } : {}),
          });
          metrics.increment('mcp_tool_calls_total', { tool: 'install_tool' });

          if (!result.success) {
            return errorResult(`Installation failed: ${result.error ?? 'unknown error'}`);
          }

          // Verify the server actually starts and speaks MCP.
          let actions: string[] | undefined;
          let startupWarning: string | undefined;
          try {
            actions = (await this.downstream().listTools(tool.id)).map((t) => t.name);
          } catch (err) {
            startupWarning =
              `Installed, but the server did not start cleanly: ${errorMessage(err)}. ` +
              'It may need launch args or credentials (TOOL_<NAME>__<VAR> on the hub). Reinstall with args if needed.';
          }

          return text({
            success: true,
            toolId: result.tool.id,
            installedAt: result.installedAt,
            path: result.path,
            ...(approvedVia !== undefined ? { approvedVia } : {}),
            ...(actions !== undefined ? { actions } : {}),
            ...(startupWarning !== undefined ? { startupWarning } : {}),
          });
        } catch (err) {
          logger.error('install_tool failed', { err: errorMessage(err) });
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Install MCP server', destructiveHint: false, openWorldHint: true },
    );

    // ── 3. uninstall_tool ─────────────────────────────────────────────────
    defineTool(
      this.server,
      'uninstall_tool',
      'Stop and remove an installed MCP server (requires approval)',
      {
        toolId: z.string().min(1).describe('ID of an installed tool'),
        approvalId: z.string().uuid().optional().describe('Approval ID once an operator approved the uninstall'),
      },
      async (args) => {
        try {
          if (!installer.isInstalled(args.toolId)) {
            return errorResult(`Tool not installed: ${args.toolId}`);
          }
          const decision = policyEngine.evaluate({
            toolId: args.toolId,
            actor: ACTOR,
            action: 'uninstall',
            environment: environment(),
          });
          if (!decision.allowed && !decision.requiresApproval) {
            return errorResult(`Policy denied uninstall: ${decision.reasons.join(', ')}`);
          }
          if (decision.requiresApproval) {
            const outcome = await this.approve(args.toolId, 'uninstall', `Uninstall ${args.toolId}`, args.approvalId);
            const blocked = this.approvalBlock(outcome, 'uninstall_tool');
            if (blocked) return blocked;
          }

          await this.downstream().close(args.toolId);
          await installer.uninstall(args.toolId, ACTOR);
          metrics.increment('mcp_tool_calls_total', { tool: 'uninstall_tool' });
          return text({ success: true, uninstalled: args.toolId });
        } catch (err) {
          logger.error('uninstall_tool failed', { err: errorMessage(err) });
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Uninstall MCP server', destructiveHint: true },
    );

    // ── 4. list_installed_tools ───────────────────────────────────────────
    defineTool(
      this.server,
      'list_installed_tools',
      'List all MCP servers installed in the hub, with their connection status',
      {},
      async () => {
        try {
          const downstream = this.downstream();
          const tools = runtimeRegistrar.list().map((rt) => ({
            id: rt.tool.id,
            name: rt.tool.name,
            version: rt.tool.version,
            description: rt.tool.description,
            status: rt.status,
            connected: downstream.isConnected(rt.tool.id),
            registeredAt: rt.registeredAt,
            capabilities: rt.tool.capabilities,
            args: rt.config.args,
          }));
          metrics.increment('mcp_tool_calls_total', { tool: 'list_installed_tools' });
          return text({ tools, count: tools.length });
        } catch (err) {
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'List installed MCP servers', readOnlyHint: true },
    );

    // ── 5. list_capability_actions ────────────────────────────────────────
    defineTool(
      this.server,
      'list_capability_actions',
      'List the actions (tools) an installed MCP server exposes, with their input schemas, so they can be called with execute_capability',
      {
        toolId: z.string().min(1).describe('ID of an installed tool'),
      },
      async (args) => {
        try {
          const actions = await this.downstream().listTools(args.toolId);
          metrics.increment('mcp_tool_calls_total', { tool: 'list_capability_actions' });
          return text({
            toolId: args.toolId,
            actions: actions.map((a) => ({
              name: a.name,
              ...(a.title !== undefined ? { title: a.title } : {}),
              ...(a.description !== undefined ? { description: a.description } : {}),
              inputSchema: a.inputSchema,
              ...(a.annotations !== undefined ? { annotations: a.annotations } : {}),
            })),
            count: actions.length,
          });
        } catch (err) {
          if (!(err instanceof DownstreamError)) {
            logger.error('list_capability_actions failed', { err: errorMessage(err) });
          }
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'List actions of an installed server', readOnlyHint: true },
    );

    // ── 6. execute_capability ─────────────────────────────────────────────
    defineTool(
      this.server,
      'execute_capability',
      'Call an action on an installed MCP server and return its result. Use list_capability_actions to see available actions and their parameters.',
      {
        toolId: z.string().min(1).describe('ID of the installed tool'),
        action: z.string().min(1).describe('Name of the action (downstream tool) to call'),
        params: z.record(z.string(), z.unknown()).optional().describe('Arguments for the action'),
        approvalId: z.string().uuid().optional().describe('Approval ID once an operator approved this call'),
      },
      async (args) => {
        try {
          if (!runtimeRegistrar.get(args.toolId)) {
            return errorResult(`Tool not registered: ${args.toolId}. Use install_tool first.`);
          }

          const decision = policyEngine.evaluate({
            toolId: args.toolId,
            actor: ACTOR,
            action: args.action,
            environment: environment(),
          });
          if (!decision.allowed && !decision.requiresApproval) {
            return errorResult(`Policy denied execution: ${decision.reasons.join(', ')}`);
          }

          // A downstream tool that declares itself destructive (and not
          // read-only) is treated as high-risk even if its name is not on
          // the policy engine's high-risk list.
          const definition = await this.downstream().describeTool(args.toolId, args.action);
          if (!definition) {
            return errorResult(
              `Unknown action '${args.action}' for ${args.toolId}. Use list_capability_actions to see valid actions.`,
            );
          }
          const annotations = definition.annotations ?? {};
          const declaredDestructive =
            annotations['destructiveHint'] === true && annotations['readOnlyHint'] !== true;

          if (decision.requiresApproval || declaredDestructive) {
            const outcome = await this.approve(
              args.toolId,
              args.action,
              `Run ${args.action} on ${args.toolId}`,
              args.approvalId,
              { params: args.params ?? {} },
            );
            const blocked = this.approvalBlock(outcome, 'execute_capability');
            if (blocked) return blocked;
          }

          const result = await this.downstream().callTool(args.toolId, args.action, args.params ?? {});
          metrics.increment('mcp_tool_calls_total', { tool: 'execute_capability' });
          return result;
        } catch (err) {
          if (!(err instanceof DownstreamError)) {
            logger.error('execute_capability failed', { err: errorMessage(err) });
          }
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Run an action on an installed server', openWorldHint: true },
    );

    // ── 7. get_hub_status ─────────────────────────────────────────────────
    defineTool(
      this.server,
      'get_hub_status',
      'Get hub status: version, installed and connected tools, providers, and metrics',
      {},
      async () => {
        try {
          const tools = runtimeRegistrar.list();
          const status = {
            timestamp: new Date().toISOString(),
            version: getServiceVersion(),
            transport: readSetting(() => config.MCP_TRANSPORT, 'unknown'),
            installedTools: tools.length,
            connectedTools: this.downstream().connectedToolIds(),
            providers: providerRouter.listProviders().map((p) => ({
              id: p.id,
              name: p.name,
              capabilities: p.capabilities,
            })),
            metrics: metrics.getSnapshot(),
          };
          metrics.increment('mcp_tool_calls_total', { tool: 'get_hub_status' });
          return text(status);
        } catch (err) {
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Hub status', readOnlyHint: true },
    );

    // ── 8. manage_policy ──────────────────────────────────────────────────
    defineTool(
      this.server,
      'manage_policy',
      'List hub policies, or add/remove a declarative policy (changes require human approval; built-in policies are protected)',
      {
        action: z.enum(['list', 'add', 'remove']).describe('Policy management action'),
        policy: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'For add: {id, name, priority?, enabled?, rules:[{match:{toolId?, action?, actor?}, action:"allow"|"deny"|"require_approval"|"log", reason}]}. For remove: {id}',
          ),
        approvalId: z.string().uuid().optional().describe('Approval ID once an operator approved the change'),
      },
      async (args) => {
        try {
          if (args.action === 'list') {
            const policies = policyEngine.listPolicies().map((p) => ({
              id: p.id,
              name: p.name,
              priority: p.priority,
              enabled: p.enabled,
              protected: PROTECTED_POLICY_IDS.has(p.id),
              rules: p.rules.map((r) => ({ action: r.action, reason: r.reason })),
            }));
            metrics.increment('mcp_tool_calls_total', { tool: 'manage_policy' });
            return text({ policies, count: policies.length });
          }

          if (!args.policy) {
            return errorResult(`policy object required for ${args.action} action`);
          }

          let apply: () => unknown;
          let summary: string;
          if (args.action === 'add') {
            const compiled = compileDeclarativePolicy(args.policy);
            summary = `Add policy '${compiled.id}' (${compiled.rules.length} rule(s))`;
            apply = (): unknown => {
              policyEngine.addPolicy(compiled);
              return { added: true, id: compiled.id };
            };
          } else {
            const policyId = args.policy['id'];
            if (typeof policyId !== 'string' || policyId.length === 0) {
              return errorResult('policy.id required for remove action');
            }
            if (PROTECTED_POLICY_IDS.has(policyId)) {
              return errorResult(`Policy '${policyId}' is a protected built-in policy and cannot be removed`);
            }
            summary = `Remove policy '${policyId}'`;
            apply = (): unknown => ({ removed: policyEngine.removePolicy(policyId), id: policyId });
          }

          const outcome = await this.approve(POLICY_RESOURCE, 'modify_config', summary, args.approvalId, {
            change: args.action,
          });
          const blocked = this.approvalBlock(outcome, 'manage_policy');
          if (blocked) return blocked;

          const result = apply();
          metrics.increment('mcp_tool_calls_total', { tool: 'manage_policy' });
          return text(result);
        } catch (err) {
          logger.error('manage_policy failed', { err: errorMessage(err) });
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Manage hub policies' },
    );

    // ── 9. route_to_provider ──────────────────────────────────────────────
    defineTool(
      this.server,
      'route_to_provider',
      'Select the best available AI provider for a capability (returns the routing decision; does not call the provider)',
      {
        capability: z.string().min(1).describe('The AI capability needed (e.g. chat, code, embedding)'),
        prompt: z.string().describe('The prompt or request the route is for'),
        provider: z.string().optional().describe('Preferred provider ID'),
      },
      async (args) => {
        try {
          const routed = providerRouter.route({
            capability: args.capability,
            ...(args.provider !== undefined ? { preferredProvider: args.provider } : {}),
            fallback: true,
          });
          if (!routed) {
            return errorResult(`No provider available for capability: ${args.capability}`);
          }
          metrics.increment('mcp_tool_calls_total', { tool: 'route_to_provider' });
          return text({
            provider: {
              id: routed.id,
              name: routed.name,
              baseUrl: routed.baseUrl,
              models: routed.models,
              maxTokens: routed.maxTokens,
            },
            capability: args.capability,
            prompt: args.prompt,
            note: 'Route established. Submit prompt directly to provider API.',
          });
        } catch (err) {
          logger.error('route_to_provider failed', { err: errorMessage(err) });
          return errorResult(`Error: ${errorMessage(err)}`);
        }
      },
      { title: 'Route to AI provider', readOnlyHint: true },
    );
  }
}
