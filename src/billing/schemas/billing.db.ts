import type { DatabaseSync } from 'node:sqlite';

export function initializeBillingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      model TEXT,
      model_tier TEXT,
      tool_name TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      api_calls INTEGER NOT NULL DEFAULT 0,
      compute_seconds REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      subtotal_usd REAL NOT NULL,
      total_usd REAL NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      org_id TEXT PRIMARY KEY,
      monthly_budget_usd REAL NOT NULL,
      alert_threshold_pct REAL NOT NULL DEFAULT 0.8,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_org_ts ON usage_events(org_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_workflow_ts ON usage_events(workflow_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_tier_ts ON usage_events(model_tier, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_ts ON usage_events(model, timestamp);
  `);
}
