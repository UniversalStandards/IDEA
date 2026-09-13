import fs from 'fs';
import path from 'path';
import { z } from 'zod';

export const PolicyAuditEntrySchema = z.object({
  timestamp: z.string().datetime(),
  orgId: z.string().min(1),
  actor: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'require_approval']),
  reason: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});

export type PolicyAuditEntry = z.infer<typeof PolicyAuditEntrySchema>;

export interface PolicyAuditQuery {
  orgId?: string;
  limit?: number;
  offset?: number;
}

export class PolicyAuditLog {
  constructor(private readonly filePath: string = path.join(process.cwd(), 'runtime', 'policy-audit.jsonl')) {}

  append(entry: Omit<PolicyAuditEntry, 'timestamp'> & { timestamp?: string }): PolicyAuditEntry {
    const normalized: PolicyAuditEntry = PolicyAuditEntrySchema.parse({
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    });

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, 'utf8');

    return normalized;
  }

  list(query: PolicyAuditQuery = {}): PolicyAuditEntry[] {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    const lines = raw
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .map((parsed) => PolicyAuditEntrySchema.parse(parsed));

    const filtered = query.orgId ? lines.filter((entry) => entry.orgId === query.orgId) : lines;

    return filtered.slice(offset, offset + limit);
  }
}
