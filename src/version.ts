/**
 * src/version.ts
 * Single source of truth for the running service version: the `version` field
 * of package.json. Resolved relative to this file so it works from both
 * `src/` (ts-jest) and `dist/` (production image, which ships package.json
 * next to `dist/`). Falls back to `0.0.0` if the file is unreadable so a
 * packaging mistake can never prevent startup.
 */

import fs from 'fs';
import path from 'path';

let cached: string | undefined;

export function getServiceVersion(): string {
  if (cached !== undefined) return cached;

  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : '0.0.0';
  } catch {
    cached = '0.0.0';
  }

  return cached;
}
