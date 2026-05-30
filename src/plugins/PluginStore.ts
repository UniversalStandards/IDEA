import { mkdirSync } from 'fs';
import path from 'path';

export type PluginLifecycleState = 'installed' | 'loaded' | 'started' | 'stopped' | 'unloaded';

export type StoredPluginState = {
  name: string;
  version: string;
  pluginPath: string;
  state: PluginLifecycleState;
  updatedAt: string;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...params: unknown[]) => void;
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: () => Record<string, unknown>[];
  };
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

function loadSqliteModule(): SqliteModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:sqlite') as SqliteModule;
}

function rowToState(row: Record<string, unknown>): StoredPluginState {
  return {
    name: String(row['name']),
    version: String(row['version']),
    pluginPath: String(row['plugin_path']),
    state: row['state'] as PluginLifecycleState,
    updatedAt: String(row['updated_at']),
  };
}

export class PluginStore {
  private db: SqliteDatabase | undefined;

  constructor(private readonly dbPath: string = path.join(process.cwd(), 'runtime', 'plugins.sqlite')) {}

  async initialize(): Promise<void> {
    const { DatabaseSync } = loadSqliteModule();
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        plugin_path TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async upsert(state: StoredPluginState): Promise<void> {
    if (!this.db) {
      throw new Error('PluginStore not initialized');
    }

    this.db
      .prepare(
        `
      INSERT INTO plugins(name, version, plugin_path, state, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        plugin_path = excluded.plugin_path,
        state = excluded.state,
        updated_at = excluded.updated_at
    `,
      )
      .run(state.name, state.version, state.pluginPath, state.state, state.updatedAt);
  }

  async get(name: string): Promise<StoredPluginState | null> {
    if (!this.db) {
      throw new Error('PluginStore not initialized');
    }

    const row = this.db
      .prepare('SELECT name, version, plugin_path, state, updated_at FROM plugins WHERE name = ?')
      .get(name);

    if (!row) return null;
    return rowToState(row);
  }

  async list(): Promise<StoredPluginState[]> {
    if (!this.db) {
      throw new Error('PluginStore not initialized');
    }

    const rows = this.db
      .prepare('SELECT name, version, plugin_path, state, updated_at FROM plugins ORDER BY name ASC')
      .all();

    return rows.map(rowToState);
  }

  async delete(name: string): Promise<void> {
    if (!this.db) {
      throw new Error('PluginStore not initialized');
    }

    this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
