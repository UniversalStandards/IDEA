import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt } from './crypto';
import { config } from '../config';
import { createLogger } from '../observability/logger';

const logger = createLogger('secret-store');

interface EncryptedRecord {
  ciphertext: string;
  updatedAt: string;
}

interface PersistedStore {
  version: number;
  secrets: Record<string, EncryptedRecord>;
}

function getEncryptionKey(): string {
  try {
    return config.ENCRYPTION_KEY;
  } catch {
    return process.env['ENCRYPTION_KEY'] ?? 'fallback-dev-key-change-me-in-prod!!';
  }
}

export class SecretStore {
  private readonly store = new Map<string, string>();

  set(key: string, value: string): void {
    if (!key || key.trim() === '') throw new Error('Secret key must not be empty');
    this.store.set(key, value);
    logger.debug('Secret stored', { key });
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  delete(key: string): boolean {
    const existed = this.store.has(key);
    this.store.delete(key);
    if (existed) logger.debug('Secret deleted', { key });
    return existed;
  }

  list(): string[] {
    return Array.from(this.store.keys());
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }

  async save(filePath: string): Promise<void> {
    const encKey = getEncryptionKey();
    const secrets: Record<string, EncryptedRecord> = {};

    for (const [key, value] of this.store.entries()) {
      secrets[key] = {
        ciphertext: encrypt(value, encKey),
        updatedAt: new Date().toISOString(),
      };
    }

    const payload: PersistedStore = { version: 1, secrets };
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.chmod(filePath, 0o600);
    logger.info('Secret store saved', { path: filePath, count: this.store.size });
  }

  async load(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      logger.info('No secret store file found, starting empty', { path: filePath });
      return;
    }

    const encKey = getEncryptionKey();
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const payload: PersistedStore = JSON.parse(raw) as PersistedStore;

    if (payload.version !== 1) {
      throw new Error(`Unsupported secret store version: ${payload.version}`);
    }

    let loaded = 0;
    for (const [key, record] of Object.entries(payload.secrets)) {
      try {
        const value = decrypt(record.ciphertext, encKey);
        this.store.set(key, value);
        loaded++;
      } catch (err) {
        logger.error('Failed to decrypt secret, skipping', { key, err });
      }
    }

    logger.info('Secret store loaded', { path: filePath, loaded });
  }
}

export const secretStore = new SecretStore();
