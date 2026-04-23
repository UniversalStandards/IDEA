/**
 * scripts/rotate-encryption-key.ts
 *
 * Offline encryption-key rotation script.
 *
 * Usage:
 *   OLD_KEY=<current-encryption-key> NEW_KEY=<new-encryption-key> \
 *     tsx scripts/rotate-encryption-key.ts [--store-path <path>]
 *
 * The script:
 *   1. Loads the persisted secret store from disk using the OLD_KEY.
 *   2. Re-encrypts every secret with the NEW_KEY.
 *   3. Writes the updated store back to the same file (atomic rename).
 *   4. Prints a summary of how many secrets were rotated.
 *
 * After the script succeeds:
 *   - Set ENCRYPTION_KEY=<new-key> in your environment.
 *   - Remove ENCRYPTION_KEY_NEW (if set).
 *   - Restart or SIGHUP the hub so it picks up the new ENCRYPTION_KEY.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt } from '../src/security/crypto';

// ─────────────────────────────────────────────────────────────────
// Argument / environment parsing
// ─────────────────────────────────────────────────────────────────

function parseArgs(): { storePath: string; oldKey: string; newKey: string } {
  const args = process.argv.slice(2);

  let storePath = path.resolve('runtime', 'secrets.json');

  for (let i = 0; i < args.length; i++) {
    const nextArg = args[i + 1];
    if (args[i] === '--store-path' && nextArg !== undefined) {
      storePath = path.resolve(nextArg);
      i++;
    }
  }

  const oldKey = process.env['OLD_KEY'] ?? process.env['ENCRYPTION_KEY'] ?? '';
  const newKey = process.env['NEW_KEY'] ?? process.env['ENCRYPTION_KEY_NEW'] ?? '';

  return { storePath, oldKey, newKey };
}

// ─────────────────────────────────────────────────────────────────
// Store file types (must stay in sync with src/security/secret-store.ts)
// ─────────────────────────────────────────────────────────────────

interface EncryptedRecord {
  ciphertext: string;
  updatedAt: string;
}

interface PersistedStore {
  version: number;
  secrets: Record<string, EncryptedRecord>;
}

// ─────────────────────────────────────────────────────────────────
// Main rotation logic
// ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { storePath, oldKey, newKey } = parseArgs();

  // Validate keys
  if (oldKey.length < 32) {
    process.stderr.write(
      'ERROR: OLD_KEY (or ENCRYPTION_KEY) must be at least 32 characters.\n',
    );
    process.exit(1);
  }
  if (newKey.length < 32) {
    process.stderr.write(
      'ERROR: NEW_KEY (or ENCRYPTION_KEY_NEW) must be at least 32 characters.\n',
    );
    process.exit(1);
  }
  if (oldKey === newKey) {
    process.stderr.write('ERROR: NEW_KEY must differ from OLD_KEY.\n');
    process.exit(1);
  }

  // Check store file exists
  if (!fs.existsSync(storePath)) {
    process.stdout.write(`INFO: No secret store found at ${storePath}. Nothing to rotate.\n`);
    process.exit(0);
  }

  // Load store
  const raw = await fs.promises.readFile(storePath, 'utf8');
  const payload: PersistedStore = JSON.parse(raw) as PersistedStore;

  if (payload.version !== 1) {
    process.stderr.write(`ERROR: Unsupported secret store version: ${String(payload.version)}\n`);
    process.exit(1);
  }

  const entries = Object.entries(payload.secrets);
  let rotatedCount = 0;
  let skippedCount = 0;
  const rotatedSecrets: Record<string, EncryptedRecord> = {};

  for (const [key, record] of entries) {
    try {
      // Decrypt with old key
      const plaintext = decrypt(record.ciphertext, oldKey);
      // Re-encrypt with new key
      const newCiphertext = encrypt(plaintext, newKey);
      // Verify round-trip
      const verified = decrypt(newCiphertext, newKey);
      if (verified !== plaintext) {
        throw new Error('Round-trip verification failed');
      }
      rotatedSecrets[key] = {
        ciphertext: newCiphertext,
        updatedAt: new Date().toISOString(),
      };
      rotatedCount++;
    } catch (err) {
      process.stderr.write(
        `WARN: Failed to rotate secret '${key}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Preserve the old record rather than losing it
      rotatedSecrets[key] = record;
      skippedCount++;
    }
  }

  // Write atomically via a temp file + rename
  const updatedPayload: PersistedStore = { version: 1, secrets: rotatedSecrets };
  const tmpPath = `${storePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(updatedPayload, null, 2), 'utf8');
  await fs.promises.chmod(tmpPath, 0o600);
  await fs.promises.rename(tmpPath, storePath);

  process.stdout.write(
    `SUCCESS: Rotated ${String(rotatedCount)} secret(s), skipped ${String(skippedCount)}.\n`,
  );
  process.stdout.write(
    'Next steps:\n' +
      '  1. Set ENCRYPTION_KEY=<new-key> in your environment.\n' +
      '  2. Remove ENCRYPTION_KEY_NEW if set.\n' +
      '  3. Restart the hub process.\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
