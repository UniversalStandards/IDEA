import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import type { DatabaseSync } from 'node:sqlite';
import { InvoiceSchema, type Invoice, type InvoiceLineItem } from '../types/billing.types';

interface UsageRow {
  model: string | null;
  tool_name: string | null;
  event_type: string;
  api_calls: number;
  compute_seconds: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number;
}

export class InvoiceGenerator {
  constructor(private readonly db: DatabaseSync) {}

  async generateMonthlyInvoice(orgId: string, year: number, month: number, outputDir: string): Promise<Invoice> {
    const periodStart = Date.UTC(year, month - 1, 1);
    const periodEnd = Date.UTC(year, month, 1);

    const rows = this.db
      .prepare(
        `SELECT model, tool_name, event_type, api_calls, compute_seconds, tokens_in, tokens_out, cost_usd
         FROM usage_events
         WHERE org_id = ? AND timestamp >= ? AND timestamp < ?`,
      )
      .all(orgId, periodStart, periodEnd) as unknown as UsageRow[];

    const grouped = new Map<string, InvoiceLineItem>();

    for (const row of rows) {
      const label = row.model ?? row.tool_name ?? row.event_type;
      const quantity = row.event_type === 'llm_call'
        ? (row.tokens_in ?? 0) + (row.tokens_out ?? 0)
        : row.event_type === 'tool_execution'
          ? row.api_calls
          : row.compute_seconds;

      const existing = grouped.get(label);
      if (existing) {
        existing.quantity += quantity;
        existing.amountUsd += row.cost_usd;
        existing.unitCostUsd = existing.quantity > 0 ? existing.amountUsd / existing.quantity : 0;
      } else {
        grouped.set(label, {
          description: label,
          quantity,
          amountUsd: row.cost_usd,
          unitCostUsd: quantity > 0 ? row.cost_usd / quantity : 0,
        });
      }
    }

    const lineItems = Array.from(grouped.values()).map((item) => ({
      ...item,
      quantity: Number(item.quantity.toFixed(6)),
      unitCostUsd: Number(item.unitCostUsd.toFixed(6)),
      amountUsd: Number(item.amountUsd.toFixed(6)),
    }));

    const subtotalUsd = Number(lineItems.reduce((sum, item) => sum + item.amountUsd, 0).toFixed(6));
    const totalUsd = subtotalUsd;
    const invoiceId = randomUUID();

    await mkdir(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, `${orgId}-${year}-${String(month).padStart(2, '0')}.invoice.json`);
    const pdfPath = path.join(outputDir, `${orgId}-${year}-${String(month).padStart(2, '0')}.invoice.pdf`);

    const invoice = InvoiceSchema.parse({
      id: invoiceId,
      orgId,
      periodStart,
      periodEnd,
      lineItems,
      subtotalUsd,
      totalUsd,
      createdAt: Date.now(),
      jsonPath,
      pdfPath,
    });

    await writeFile(jsonPath, JSON.stringify(invoice, null, 2), 'utf8');
    await this.writePdf(invoice);

    this.db
      .prepare(
        `INSERT INTO invoices (id, org_id, period_start, period_end, subtotal_usd, total_usd, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invoice.id,
        invoice.orgId,
        invoice.periodStart,
        invoice.periodEnd,
        invoice.subtotalUsd,
        invoice.totalUsd,
        JSON.stringify(invoice),
        invoice.createdAt,
      );

    return invoice;
  }

  private async writePdf(invoice: Invoice): Promise<void> {
    const pdfkit = await import('pdfkit');
    const PDFDocument = (pdfkit.default ?? pdfkit) as unknown as new () => {
      pipe: (stream: NodeJS.WritableStream) => void;
      fontSize: (size: number) => { text: (value: string) => unknown };
      text: (value: string) => unknown;
      moveDown: () => unknown;
      end: () => void;
      on: (event: string, cb: () => void) => void;
    };

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument();
      const stream = createWriteStream(invoice.pdfPath);
      stream.on('error', reject);
      stream.on('finish', resolve);
      doc.pipe(stream);

      doc.fontSize(18).text(`Invoice ${invoice.id}`);
      doc.text(`Org: ${invoice.orgId}`);
      doc.text(`Period: ${new Date(invoice.periodStart).toISOString()} to ${new Date(invoice.periodEnd).toISOString()}`);
      doc.moveDown();

      for (const line of invoice.lineItems) {
        doc.text(`${line.description} | qty ${line.quantity} | unit $${line.unitCostUsd.toFixed(6)} | amount $${line.amountUsd.toFixed(6)}`);
      }

      doc.moveDown();
      doc.text(`Total (USD): $${invoice.totalUsd.toFixed(6)}`);
      doc.end();
    });
  }
}
