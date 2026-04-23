#!/usr/bin/env tsx
/**
 * scripts/verify-audit-log.ts
 *
 * Verify the HMAC integrity of every entry in a JSONL audit log file.
 * Re-computes the HMAC-SHA256 signature for each entry and compares it
 * against the stored `hmac` field. Entries that have been tampered with,
 * are missing the HMAC field, or cannot be parsed are flagged as failures.
 *
 * Usage:
 *   tsx scripts/verify-audit-log.ts [options] <path-to-audit.jsonl>
 *
 * Options:
 *   --key <secret>   Explicit ENCRYPTION_KEY to use (overrides env var).
 *   --env <file>     Path to .env file to load (default: .env).
 *   --quiet          Only print a summary line; suppress per-entry output.
 *   --fail-fast      Exit immediately on the first tampered entry.
 *
 * Exit codes:
 *   0  All entries verified successfully.
 *   1  One or more entries failed verification or the file could not be read.
 *   2  Usage error (bad arguments).
 *
 * Environment variables:
 *   ENCRYPTION_KEY   The secret used to sign audit entries (required).
 */

import { createReadStream, existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────
// Minimal dotenv loader — avoids pulling in the full app bootstrap
// ─────────────────────────────────────────────────────────────────

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// HMAC helpers (no external deps)
// ─────────────────────────────────────────────────────────────────

function computeHmac(payload: string, secret: string): string {
  // Mirror the key-padding logic in src/security/crypto.ts
  const keyHex =
    secret.length === 64 && /^[0-9a-fA-F]+$/.test(secret)
      ? secret
      : createHash('sha256').update(secret).digest('hex');

  return createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(payload)
    .digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a comparison to avoid length-based timing leak
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ─────────────────────────────────────────────────────────────────
// Audit entry shape (mirrors src/types/index.ts AuditEntry)
// ─────────────────────────────────────────────────────────────────

interface AuditEntryRaw {
  id?: unknown;
  action?: unknown;
  actor?: unknown;
  resource?: unknown;
  outcome?: unknown;
  correlationId?: unknown;
  hmac?: unknown;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────
// Verification logic
// ─────────────────────────────────────────────────────────────────

type VerifyResult =
  | { status: 'ok'; line: number }
  | { status: 'tampered'; line: number; id: string; expected: string; stored: string }
  | { status: 'unsigned'; line: number; id: string }
  | { status: 'parse_error'; line: number; raw: string; message: string }
  | { status: 'missing_fields'; line: number; id: string; missing: string[] };

function verifyEntry(raw: string, lineNumber: number, secret: string): VerifyResult {
  let entry: AuditEntryRaw;
  try {
    entry = JSON.parse(raw) as AuditEntryRaw;
  } catch (err) {
    return {
      status: 'parse_error',
      line: lineNumber,
      raw: raw.slice(0, 120),
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const id = typeof entry.id === 'string' ? entry.id : `<line ${lineNumber}>`;

  // Check required signing fields
  const required = ['id', 'action', 'actor', 'resource', 'outcome', 'correlationId'] as const;
  const missing = required.filter((f) => entry[f] === undefined || entry[f] === null);
  if (missing.length > 0) {
    return { status: 'missing_fields', line: lineNumber, id, missing };
  }

  // Check HMAC field presence
  if (entry.hmac === undefined || entry.hmac === null) {
    return { status: 'unsigned', line: lineNumber, id };
  }

  // Reconstruct the exact payload signed by audit.ts
  const payload = JSON.stringify({
    id: entry.id,
    action: entry.action,
    actor: entry.actor,
    resource: entry.resource,
    outcome: entry.outcome,
    correlationId: entry.correlationId,
  });

  const expected = computeHmac(payload, secret);
  const stored = String(entry.hmac);

  if (!constantTimeEqual(expected, stored)) {
    return { status: 'tampered', line: lineNumber, id, expected, stored };
  }

  return { status: 'ok', line: lineNumber };
}

// ─────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────

interface CliArgs {
  filePath: string;
  encryptionKey: string;
  quiet: boolean;
  failFast: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip node + script
  let filePath = '';
  let explicitKey = '';
  let envFile = resolve(process.cwd(), '.env');
  let quiet = false;
  let failFast = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--key') {
      explicitKey = args[++i] ?? '';
    } else if (arg === '--env') {
      envFile = resolve(process.cwd(), args[++i] ?? '.env');
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--fail-fast') {
      failFast = true;
    } else if (!arg.startsWith('--')) {
      filePath = arg;
    }
  }

  if (!filePath) {
    process.stderr.write(
      'Usage: tsx scripts/verify-audit-log.ts [--key <secret>] [--env <file>] [--quiet] [--fail-fast] <audit.jsonl>\n',
    );
    process.exit(2);
  }

  // Load .env before reading ENCRYPTION_KEY from process.env
  loadEnvFile(envFile);

  const encryptionKey = explicitKey || process.env['ENCRYPTION_KEY'] || '';
  if (!encryptionKey) {
    process.stderr.write(
      'Error: ENCRYPTION_KEY environment variable is required (or pass --key <secret>).\n',
    );
    process.exit(2);
  }

  return { filePath: resolve(process.cwd(), filePath), encryptionKey, quiet, failFast };
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { filePath, encryptionKey, quiet, failFast } = parseArgs(process.argv);

  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  const rl = createInterface({
    input: createReadStream(filePath, 'utf8'),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0; // empty lines
  let earlyExit = false;

  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) {
      skipped++;
      continue;
    }

    const result = verifyEntry(trimmed, lineNumber, encryptionKey);

    if (result.status === 'ok') {
      ok++;
      if (!quiet) {
        process.stdout.write(`  ✔ line ${result.line}\n`);
      }
    } else {
      failed++;
      switch (result.status) {
        case 'tampered':
          process.stdout.write(
            `  ✘ line ${result.line} [TAMPERED] id=${result.id}\n` +
              `      stored:   ${result.stored}\n` +
              `      expected: ${result.expected}\n`,
          );
          break;
        case 'unsigned':
          process.stdout.write(
            `  ✘ line ${result.line} [UNSIGNED] id=${result.id} — hmac field is absent\n`,
          );
          break;
        case 'missing_fields':
          process.stdout.write(
            `  ✘ line ${result.line} [MISSING_FIELDS] id=${result.id} — missing: ${result.missing.join(', ')}\n`,
          );
          break;
        case 'parse_error':
          process.stdout.write(
            `  ✘ line ${result.line} [PARSE_ERROR] ${result.message}\n` +
              `      raw: ${result.raw}\n`,
          );
          break;
      }

      if (failFast) {
        earlyExit = true;
        rl.close();
        break;
      }
    }
  }

  const total = ok + failed;
  process.stdout.write('\n');
  process.stdout.write(`Audit log verification complete: ${filePath}\n`);
  process.stdout.write(`  Lines processed : ${total} (${skipped} empty skipped)\n`);
  process.stdout.write(`  Verified OK     : ${ok}\n`);
  process.stdout.write(`  Failed          : ${failed}\n`);

  if (earlyExit) {
    process.stdout.write('  (--fail-fast: stopped after first failure)\n');
  }

  if (failed > 0) {
    process.stdout.write('\nResult: FAILED — integrity violations detected.\n');
    process.exit(1);
  } else {
    process.stdout.write('\nResult: PASSED — all entries verified.\n');
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
