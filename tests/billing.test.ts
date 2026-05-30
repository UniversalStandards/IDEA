import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BillingDatabase,
  BudgetEnforcer,
  CostAttributor,
  CostRouter,
  FinOpsDashboard,
  InvoiceGenerator,
  UsageMetering,
} from '../src/billing';

jest.mock(
  'pdfkit',
  () => ({
    __esModule: true,
    default: class FakePDFDocument {
      private stream: NodeJS.WritableStream | null = null;

      pipe(stream: NodeJS.WritableStream): NodeJS.WritableStream {
        this.stream = stream;
        return stream;
      }

      fontSize(): this {
        return this;
      }

      text(): this {
        return this;
      }

      moveDown(): this {
        return this;
      }

      on(): this {
        return this;
      }

      end(): void {
        this.stream?.write('FAKE_PDF');
        this.stream?.end();
      }
    },
  }),
  { virtual: true },
);

describe('Billing module', () => {
  let database: BillingDatabase;
  let attributor: CostAttributor;
  let metering: UsageMetering;

  beforeEach(() => {
    database = new BillingDatabase();
    attributor = new CostAttributor([
      {
        model: 'gpt-4o-mini',
        tier: 'standard',
        inputPer1kTokensUsd: 0.001,
        outputPer1kTokensUsd: 0.002,
        toolExecutionUsd: 0.01,
        computeSecondUsd: 0.005,
      },
      {
        model: 'default',
        tier: 'standard',
        inputPer1kTokensUsd: 0.001,
        outputPer1kTokensUsd: 0.002,
        toolExecutionUsd: 0.01,
        computeSecondUsd: 0.005,
      },
    ]);
    metering = new UsageMetering(database.connection, attributor);
  });

  afterEach(() => {
    database.close();
  });

  it('records LLM usage asynchronously with low latency', async () => {
    const started = Date.now();
    metering.record({
      orgId: 'org-1',
      workflowId: 'wf-1',
      agentId: 'agent-1',
      eventType: 'llm_call',
      model: 'gpt-4o-mini',
      tokensIn: 1000,
      tokensOut: 500,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(10);

    await metering.drain();

    const row = database.connection
      .prepare('SELECT COUNT(*) as count, ROUND(SUM(cost_usd), 6) as total FROM usage_events WHERE org_id = ?')
      .get('org-1') as { count: number; total: number };

    expect(row.count).toBe(1);
    expect(row.total).toBe(0.002);
  });

  it('enforces budget with 402-style decision and emits event', async () => {
    const enforcer = new BudgetEnforcer(database.connection);
    enforcer.configureBudget({ orgId: 'org-1', monthlyBudgetUsd: 1, alertThresholdPct: 0.8 });

    metering.record({
      orgId: 'org-1',
      workflowId: 'wf-1',
      agentId: 'agent-1',
      eventType: 'llm_call',
      model: 'gpt-4o-mini',
      tokensIn: 500,
      tokensOut: 250,
    });
    await metering.drain();

    const exceeded = jest.fn();
    enforcer.on('budget.exceeded', exceeded);

    const decision = enforcer.enforce('org-1', 1.5);
    expect(decision.allowed).toBe(false);
    expect(decision.statusCode).toBe(402);
    expect(exceeded).toHaveBeenCalledTimes(1);
  });

  it('generates monthly invoice JSON and PDF totals matching usage', async () => {
    const now = new Date();
    const ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2);

    metering.record({
      orgId: 'org-2',
      workflowId: 'wf-2',
      agentId: 'agent-2',
      eventType: 'llm_call',
      model: 'gpt-4o-mini',
      tokensIn: 1000,
      tokensOut: 500,
      timestamp: ts,
    });
    metering.record({
      orgId: 'org-2',
      workflowId: 'wf-2',
      agentId: 'agent-2',
      eventType: 'tool_execution',
      model: 'gpt-4o-mini',
      apiCalls: 2,
      timestamp: ts,
    });
    await metering.drain();

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'billing-invoice-'));
    try {
      const generator = new InvoiceGenerator(database.connection);
      const invoice = await generator.generateMonthlyInvoice('org-2', now.getUTCFullYear(), now.getUTCMonth() + 1, outputDir);

      const payload = JSON.parse(await readFile(invoice.jsonPath, 'utf8')) as { totalUsd: number };
      const pdfStats = await stat(invoice.pdfPath);

      const sum = database.connection
        .prepare('SELECT ROUND(SUM(cost_usd), 6) as total FROM usage_events WHERE org_id = ?')
        .get('org-2') as { total: number };

      expect(payload.totalUsd).toBe(sum.total);
      expect(invoice.totalUsd).toBe(sum.total);
      expect(pdfStats.size).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('returns finops dashboard aggregates and model tier routing data', async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    metering.record({
      orgId: 'org-3',
      workflowId: 'wf-a',
      agentId: 'agent-a',
      eventType: 'llm_call',
      model: 'gpt-4o-mini',
      tokensIn: 2000,
      tokensOut: 1000,
    });
    metering.record({
      orgId: 'org-3',
      workflowId: 'wf-b',
      agentId: 'agent-b',
      eventType: 'compute_second',
      model: 'gpt-4o-mini',
      computeSeconds: 10,
    });
    await metering.drain();

    const dashboard = new FinOpsDashboard(database.connection);
    const byOrg = dashboard.costByOrg(month);
    const top = dashboard.topWorkflows('org-3', 2);
    const projected = dashboard.projectedMonthEnd('org-3');

    expect(byOrg[0]?.orgId).toBe('org-3');
    expect(top).toHaveLength(2);
    expect(projected.projectedSpendUsd).toBeGreaterThan(0);

    const router = new CostRouter(attributor);
    expect(router.getCostPerModelTier()['standard']).toBe(0.003);
    expect(router.chooseLowestCostModel(['gpt-4o-mini'])).toBe('gpt-4o-mini');
  });
});
