import { z } from 'zod';

export const BillingPeriodSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

export const UsageEventSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  workflowId: z.string().min(1),
  agentId: z.string().min(1),
  eventType: z.enum(['token_usage', 'tool_execution', 'workflow_execution', 'adjustment']),
  model: z.string().min(1).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  timestamp: z.string().min(1),
});

export const CostRecordSchema = z.object({
  orgId: z.string().min(1),
  period: BillingPeriodSchema,
  totalCostUsd: z.number().nonnegative(),
  breakdown: z.object({}).catchall(z.number().nonnegative()),
});

export const InvoiceLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().nonnegative(),
  unitCostUsd: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});

export const InvoiceSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  period: BillingPeriodSchema,
  lineItems: z.array(InvoiceLineSchema),
  totalUsd: z.number().nonnegative(),
  status: z.enum(['draft', 'issued', 'paid', 'void']),
});
