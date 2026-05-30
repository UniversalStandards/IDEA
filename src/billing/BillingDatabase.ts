import { DatabaseSync } from 'node:sqlite';
import { initializeBillingSchema } from './schemas/billing.db';

export interface BillingDatabaseOptions {
  path?: string;
}

export class BillingDatabase {
  private readonly db: DatabaseSync;

  constructor(options: BillingDatabaseOptions = {}) {
    const path = options.path ?? ':memory:';
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    initializeBillingSchema(this.db);
  }

  get connection(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
