import {
  StreamEventType,
  TenantPlan,
  TenantStatus,
  PluginPermission,
  PluginStatus,
  StreamEventSchema,
  StreamMetaSchema,
  UsageEventSchema,
  InvoiceSchema,
  TenantSchema,
  PluginSchema,
  PolicyRuleSchema,
  CsaTrustLevelSchema,
} from '../../src/types';

describe('type registry schemas', () => {
  it('validates representative records for each new type group', () => {
    expect(
      StreamEventSchema.parse({
        streamId: 'stream-1',
        orgId: 'org-1',
        eventType: StreamEventType.TOKEN,
        sequence: 1,
        data: { token: 'hello' },
        timestamp: new Date().toISOString(),
      }).eventType,
    ).toBe(StreamEventType.TOKEN);

    expect(
      StreamMetaSchema.parse({
        streamId: 'stream-1',
        protocol: 'sse',
        createdAt: new Date().toISOString(),
        status: 'open',
      }).protocol,
    ).toBe('sse');

    expect(
      UsageEventSchema.parse({
        id: 'usage-1',
        orgId: 'org-1',
        workflowId: 'wf-1',
        agentId: 'agent-1',
        eventType: 'token_usage',
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.01,
        timestamp: new Date().toISOString(),
      }).eventType,
    ).toBe('token_usage');

    expect(
      InvoiceSchema.parse({
        id: 'invoice-1',
        orgId: 'org-1',
        period: { start: '2026-05-01', end: '2026-05-31' },
        lineItems: [{ description: 'LLM tokens', quantity: 1, unitCostUsd: 5, totalCostUsd: 5 }],
        totalUsd: 5,
        status: 'issued',
      }).status,
    ).toBe('issued');

    expect(
      TenantSchema.parse({
        id: 'tenant-1',
        name: 'Acme',
        status: TenantStatus.ACTIVE,
        plan: TenantPlan.PRO,
        createdAt: new Date().toISOString(),
        settings: { region: 'us-east-1' },
      }).plan,
    ).toBe(TenantPlan.PRO);

    expect(
      PluginSchema.parse({
        manifest: {
          name: 'demo-plugin',
          version: '1.0.0',
          description: 'demo',
          permissions: [PluginPermission.READ_CAPABILITIES],
          entrypoint: 'dist/index.js',
          hooks: ['onWorkflowComplete'],
        },
        status: PluginStatus.LOADED,
        loadedAt: new Date().toISOString(),
        instanceId: 'instance-1',
      }).status,
    ).toBe(PluginStatus.LOADED);

    expect(
      PolicyRuleSchema.parse({
        id: 'rule-1',
        orgId: 'org-1',
        effect: 'allow',
        action: 'workflow.execute',
        resource: 'workflow:*',
      }).effect,
    ).toBe('allow');

    expect(
      CsaTrustLevelSchema.parse({
        level: 3,
        name: 'trusted',
        permissions: ['workflow.execute'],
      }).level,
    ).toBe(3);
  });
});
