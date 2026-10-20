/**
 * src/provisioning/install-state.ts
 * Durable record of installed tools so a restarted hub (container restart,
 * redeploy, new stdio session with the data volume mounted) restores its
 * runtime registry without reinstalling anything.
 *
 * Only non-secret data is persisted: tool metadata, launch args, install
 * path. Credentials are never written — they are re-derived from the hub's
 * environment on restore (see config-generator).
 *
 * Writes are atomic (temp file + rename) so a crash mid-write never leaves a
 * truncated state file behind.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { createLogger } from '../observability/logger';
import type { ToolMetadata } from '../discovery/types';
import { withFileLock } from './file-lock';

const logger = createLogger('install-state');

const STATE_VERSION = 1;

const ToolMetadataSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string(),
    description: z.string(),
    source: z.enum(['github', 'official', 'enterprise', 'local', 'unknown']),
    registryUrl: z.string().optional(),
    repository: z.string().optional(),
    installCommand: z.string().optional(),
    entryPoint: z.string().optional(),
    capabilities: z.array(z.string()),
    tags: z.array(z.string()),
    author: z.string().optional(),
    license: z.string().optional(),
    downloadCount: z.number().optional(),
    verified: z.boolean().optional(),
    riskLevel: z.enum(['low', 'medium', 'high']).optional(),
    dependencies: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const InstalledRecordSchema = z.object({
  tool: ToolMetadataSchema,
  args: z.array(z.string()),
  installPath: z.string(),
  installedAt: z.string(),
});

const StateFileSchema = z.object({
  version: z.literal(STATE_VERSION),
  tools: z.array(InstalledRecordSchema),
});

export interface InstalledRecord {
  tool: ToolMetadata;
  args: string[];
  installPath: string;
  installedAt: string;
}

export class InstallStateStore {
  constructor(private readonly filePath: string) {}

  getFilePath(): string {
    return this.filePath;
  }

  load(): InstalledRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const parsed = StateFileSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error('Install state file is invalid; ignoring it', {
          file: this.filePath,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return [];
      }
      return parsed.data.tools.map((r) => ({
        tool: r.tool as unknown as ToolMetadata,
        args: r.args,
        installPath: r.installPath,
        installedAt: r.installedAt,
      }));
    } catch (err) {
      logger.error('Failed to read install state; ignoring it', {
        file: this.filePath,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Read-modify-write under a cross-process lock, so hub processes sharing
   * one data directory never overwrite each other's install records.
   */
  async update(mutate: (records: InstalledRecord[]) => InstalledRecord[]): Promise<void> {
    await withFileLock(`${this.filePath}.lock`, { timeoutMs: 30_000, staleMs: 60_000, pollMs: 50 }, () => {
      this.save(mutate(this.load()));
    });
  }

  save(records: InstalledRecord[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify({ version: STATE_VERSION, tools: records }, null, 2);
    fs.writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
