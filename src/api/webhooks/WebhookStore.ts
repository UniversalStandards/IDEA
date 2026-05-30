import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const WebhookEventTypeSchema = z.enum([
  'capability.installed',
  'workflow.completed',
  'quota.exceeded',
  'provider.health_changed',
]);

export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

const WebhookEventsSchema = z.array(WebhookEventTypeSchema).min(1);

const WebhookRecordSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  url: z.string().url(),
  events: WebhookEventsSchema,
  secret: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type WebhookRecord = z.infer<typeof WebhookRecordSchema>;

export const DeadLetterRecordSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  orgId: z.string().min(1),
  eventType: WebhookEventTypeSchema,
  payload: z.unknown(),
  lastError: z.string().min(1),
  attempts: z.number().int().min(1),
  failedAt: z.string().min(1),
});

export type DeadLetterRecord = z.infer<typeof DeadLetterRecordSchema>;

export type CreateWebhookInput = {
  orgId: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
};

const DEFAULT_DB_PATH = path.join(process.cwd(), 'runtime', 'webhooks.sqlite');

export class WebhookStore {
  private db: DatabaseSync | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {}

  async initialize(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async (): Promise<void> => {
      if (this.dbPath !== ':memory:') {
        await mkdir(path.dirname(this.dbPath), { recursive: true });
      }

      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          endpoint_url TEXT NOT NULL,
          events TEXT NOT NULL,
          secret TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS webhook_dead_letters (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          last_error TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          failed_at TEXT NOT NULL
        );
      `);
    })();

    await this.initPromise;
  }

  async create(input: CreateWebhookInput): Promise<WebhookRecord> {
    await this.initialize();
    const now = new Date().toISOString();
    const record = WebhookRecordSchema.parse({
      id: randomUUID(),
      orgId: input.orgId,
      url: input.url,
      events: input.events,
      secret: input.secret,
      createdAt: now,
      updatedAt: now,
    });

    this.getDb()
      .prepare(
        `INSERT INTO webhooks (id, org_id, endpoint_url, events, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.orgId,
        record.url,
        JSON.stringify(record.events),
        record.secret,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  async listByOrg(orgId: string): Promise<WebhookRecord[]> {
    await this.initialize();
    const rows = this.getDb()
      .prepare(
        `SELECT id, org_id, endpoint_url, events, secret, created_at, updated_at
         FROM webhooks WHERE org_id = ? ORDER BY created_at ASC`,
      )
      .all(orgId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.parseWebhookRow(row));
  }

  async listByEvent(orgId: string, eventType: WebhookEventType): Promise<WebhookRecord[]> {
    const hooks = await this.listByOrg(orgId);
    return hooks.filter((hook) => hook.events.includes(eventType));
  }

  async get(id: string): Promise<WebhookRecord | undefined> {
    await this.initialize();
    const row = this.getDb()
      .prepare(
        `SELECT id, org_id, endpoint_url, events, secret, created_at, updated_at
         FROM webhooks WHERE id = ? LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }
    return this.parseWebhookRow(row);
  }

  async delete(id: string): Promise<boolean> {
    await this.initialize();
    const result = this.getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  async recordDeadLetter(input: Omit<DeadLetterRecord, 'id' | 'failedAt'>): Promise<DeadLetterRecord> {
    await this.initialize();
    const record = DeadLetterRecordSchema.parse({
      id: randomUUID(),
      ...input,
      failedAt: new Date().toISOString(),
    });

    this.getDb()
      .prepare(
        `INSERT INTO webhook_dead_letters (id, webhook_id, org_id, event_type, payload, last_error, attempts, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.webhookId,
        record.orgId,
        record.eventType,
        JSON.stringify(record.payload),
        record.lastError,
        record.attempts,
        record.failedAt,
      );

    return record;
  }

  async listDeadLetters(orgId: string): Promise<DeadLetterRecord[]> {
    await this.initialize();
    const rows = this.getDb()
      .prepare(
        `SELECT id, webhook_id, org_id, event_type, payload, last_error, attempts, failed_at
         FROM webhook_dead_letters WHERE org_id = ? ORDER BY failed_at DESC`,
      )
      .all(orgId) as Array<Record<string, unknown>>;

    return rows.map((row) =>
      DeadLetterRecordSchema.parse({
        id: row['id'],
        webhookId: row['webhook_id'],
        orgId: row['org_id'],
        eventType: row['event_type'],
        payload: JSON.parse(String(row['payload'])),
        lastError: row['last_error'],
        attempts: row['attempts'],
        failedAt: row['failed_at'],
      }),
    );
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.initPromise = undefined;
  }

  private parseWebhookRow(row: Record<string, unknown>): WebhookRecord {
    return WebhookRecordSchema.parse({
      id: row['id'],
      orgId: row['org_id'],
      url: row['endpoint_url'],
      events: JSON.parse(String(row['events'])),
      secret: row['secret'],
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('WebhookStore is not initialized');
    }
    return this.db;
  }
}

export const webhookStore = new WebhookStore();
