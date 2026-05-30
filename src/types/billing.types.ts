import { z } from 'zod';

export const UsageEventTypeSchema = z.enum(['llm_call', 'tool_execution', 'compute_second']);

export const UsageEventSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  workflowId: z.string().min(1),
  agentId: z.string().min(1),
  eventType: UsageEventTypeSchema,
  model: z.string().min(1).optional(),
  modelTier: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  apiCalls: z.number().int().nonnegative().default(0),
  computeSeconds: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).default({}),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const CostRecordSchema = z.object({
  eventId: z.string().min(1),
  orgId: z.string().min(1),
  workflowId: z.string().min(1),
  agentId: z.string().min(1),
  modelTier: z.string().min(1).optional(),
  costUsd: z.number().nonnegative(),
  timestamp: z.number().int().nonnegative(),
});

export type CostRecord = z.infer<typeof CostRecordSchema>;

export const InvoiceLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().nonnegative(),
  unitCostUsd: z.number().nonnegative(),
  amountUsd: z.number().nonnegative(),
});

export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

export const InvoiceSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  periodStart: z.number().int().nonnegative(),
  periodEnd: z.number().int().nonnegative(),
  currency: z.literal('USD').default('USD'),
  lineItems: z.array(InvoiceLineItemSchema),
  subtotalUsd: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  jsonPath: z.string().min(1),
  pdfPath: z.string().min(1),
});

export type Invoice = z.infer<typeof InvoiceSchema>;

export const ModelPriceSchema = z.object({
  model: z.string().min(1),
  tier: z.string().min(1),
  inputPer1kTokensUsd: z.number().nonnegative().default(0),
  outputPer1kTokensUsd: z.number().nonnegative().default(0),
  toolExecutionUsd: z.number().nonnegative().default(0),
  computeSecondUsd: z.number().nonnegative().default(0),
});

export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const BudgetSchema = z.object({
  orgId: z.string().min(1),
  monthlyBudgetUsd: z.number().positive(),
  alertThresholdPct: z.number().min(0).max(1).default(0.8),
});

export type Budget = z.infer<typeof BudgetSchema>;
