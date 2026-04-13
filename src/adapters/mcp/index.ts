import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { registryManager } from '../../discovery/registry-manager';
import { installer } from '../../provisioning/installer';
import { runtimeRegistrar } from '../../provisioning/runtime-registrar';
import { policyEngine } from '../../policy/policy-engine';
import { providerRouter } from '../../routing/provider-router';
import { requestNormalizer } from '../../normalization/request-normalizer';

const logger = createLogger('mcp-adapter');

export class MCPAdapter {
  private readonly server: McpServer;

  constructor() {
    this.server = new McpServer({
      name: 'IDEA Hub',
      version: '1.0.0',
    });

    this.registerTools();
    logger.info('MCP adapter initialized');
  }

  private registerTools(): void {
    // 1. discover_capabilities
    this.server.tool(
      'discover_capabilities',
      'Search registries for tools and capabilities matching a query',
      {
        query: z.string().describe('Search query for capabilities or tools'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return'),
      },
      async (args) => {
        try {
          const query = args['query'] as string;
          const limit = args['limit'] as number | undefined;
          const results = await registryManager.search({
            query,
            limit: limit ?? 20,
          });
          metrics.increment('mcp_tool_calls_total', { tool: 'discover_capabilities' });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ tools: results, count: results.length }, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('discover_capabilities failed', { err: message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 2. install_tool
    this.server.tool(
      'install_tool',
      'Install a tool through the full pipeline (discovery, policy check, install)',
      {
        toolId: z.string().describe('The tool ID to install'),
      },
      async (args) => {
        try {
          const toolId = args['toolId'] as string;
          const tool = await registryManager.getById(toolId);
          if (!tool) {
            return {
              content: [{ type: 'text' as const, text: `Tool not found: ${toolId}` }],
              isError: true,
            };
          }

          const decision = policyEngine.evaluate({
            toolId,
            actor: 'mcp-client',
            action: 'install',
            environment: process.env['NODE_ENV'] ?? 'development',
          });

          if (!decision.allowed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Policy denied installation: ${decision.reasons.join(', ')}`,
                },
              ],
              isError: true,
            };
          }

          const result = await installer.install(tool);
          metrics.increment('mcp_tool_calls_total', { tool: 'install_tool' });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    success: result.success,
                    toolId: result.tool.id,
                    installedAt: result.installedAt,
                    path: result.path,
                    error: result.error,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('install_tool failed', { err: message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 3. list_installed_tools
    this.server.tool(
      'list_installed_tools',
      'List all tools currently registered in the runtime',
      {},
      async () => {
        try {
          const tools = runtimeRegistrar.list().map((rt) => ({
            id: rt.tool.id,
            name: rt.tool.name,
            version: rt.tool.version,
            status: rt.status,
            registeredAt: rt.registeredAt,
            capabilities: rt.tool.capabilities,
          }));
          metrics.increment('mcp_tool_calls_total', { tool: 'list_installed_tools' });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ tools, count: tools.length }, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 4. execute_capability
    this.server.tool(
      'execute_capability',
      'Execute an action on a registered tool',
      {
        toolId: z.string().describe('The ID of the tool to execute'),
        action: z.string().describe('The action to perform'),
        params: z.record(z.string(), z.unknown()).optional().describe('Action parameters'),
      },
      async (args) => {
        try {
          const toolId = args['toolId'] as string;
          const action = args['action'] as string;
          const params = args['params'] as Record<string, unknown> | undefined;
          const registered = runtimeRegistrar.get(toolId);
          if (!registered) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Tool not registered: ${toolId}. Use install_tool first.`,
                },
              ],
              isError: true,
            };
          }

          const decision = policyEngine.evaluate({
            toolId,
            actor: 'mcp-client',
            action,
            environment: process.env['NODE_ENV'] ?? 'development',
          });

          if (!decision.allowed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Policy denied execution: ${decision.reasons.join(', ')}`,
                },
              ],
              isError: true,
            };
          }

          const normalized = requestNormalizer.normalize(
            { method: action, params: params ?? {}, toolId },
            'mcp',
          );

          metrics.increment('mcp_tool_calls_total', { tool: 'execute_capability' });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    executed: true,
                    toolId,
                    action,
                    requestId: normalized.id,
                    status: registered.status,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('execute_capability failed', { err: message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 5. get_hub_status
    this.server.tool(
      'get_hub_status',
      'Get current hub status including metrics, installed tools, and provider list',
      {},
      async () => {
        try {
          const snapshot = metrics.getSnapshot();
          const tools = runtimeRegistrar.list();
          const providers = providerRouter.listProviders();

          const status = {
            timestamp: new Date().toISOString(),
            installedTools: tools.length,
            runningTools: tools.filter((t) => t.status === 'running').length,
            providers: providers.map((p) => ({
              id: p.id,
              name: p.name,
              capabilities: p.capabilities,
            })),
            metrics: snapshot,
          };

          metrics.increment('mcp_tool_calls_total', { tool: 'get_hub_status' });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(status, null, 2) },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 6. manage_policy
    this.server.tool(
      'manage_policy',
      'Manage hub policies: list, add, or remove policy rules',
      {
        action: z
          .enum(['list', 'add', 'remove'])
          .describe('Policy management action'),
        policy: z.record(z.string(), z.unknown()).optional().describe('Policy object for add/remove actions'),
      },
      async (args) => {
        try {
          let result: unknown;
          const action = args['action'] as 'list' | 'add' | 'remove';
          const policy = args['policy'] as Record<string, unknown> | undefined;

          switch (action) {
            case 'list': {
              const policies = policyEngine.listPolicies();
              result = { policies, count: policies.length };
              break;
            }
            case 'add': {
              if (!policy) {
                return {
                  content: [
                    { type: 'text' as const, text: 'policy object required for add action' },
                  ],
                  isError: true,
                };
              }
              policyEngine.addPolicy(policy as unknown as Parameters<typeof policyEngine.addPolicy>[0]);
              result = { added: true };
              break;
            }
            case 'remove': {
              const policyId = policy?.['id'] as string | undefined;
              if (!policyId) {
                return {
                  content: [
                    { type: 'text' as const, text: 'policy.id required for remove action' },
                  ],
                  isError: true,
                };
              }
              policyEngine.removePolicy(policyId);
              result = { removed: true, id: policyId };
              break;
            }
          }

          metrics.increment('mcp_tool_calls_total', { tool: 'manage_policy' });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('manage_policy failed', { err: message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

    // 7. route_to_provider
    this.server.tool(
      'route_to_provider',
      'Route an AI request to the best available provider',
      {
        capability: z.string().describe('The AI capability needed (e.g. chat, code, embedding)'),
        prompt: z.string().describe('The prompt or request to send'),
        provider: z.string().optional().describe('Preferred provider ID'),
      },
      async (args) => {
        try {
          const capability = args['capability'] as string;
          const provider = args['provider'] as string | undefined;
          const prompt = args['prompt'] as string;
          const routed = providerRouter.route({
            capability,
            ...(provider !== undefined ? { preferredProvider: provider } : {}),
            fallback: true,
          });

          if (!routed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No provider available for capability: ${capability}`,
                },
              ],
              isError: true,
            };
          }

          metrics.increment('mcp_tool_calls_total', { tool: 'route_to_provider' });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    provider: {
                      id: routed.id,
                      name: routed.name,
                      baseUrl: routed.baseUrl,
                      models: routed.models,
                      maxTokens: routed.maxTokens,
                    },
                    capability,
                    prompt,
                    note: 'Route established. Submit prompt directly to provider API.',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('route_to_provider failed', { err: message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  async connect(transport: Parameters<McpServer['connect']>[0]): Promise<void> {
    await this.server.connect(transport);
    logger.info('MCP adapter connected to transport');
  }

  getServer(): McpServer {
    return this.server;
  }
}
