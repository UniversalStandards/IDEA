/**
 * src/provisioning/file-lock.ts
 * Advisory cross-process lock built on exclusive file creation
 * (`open(path, 'wx')` is atomic on local filesystems and Docker volumes).
 *
 * Several hub processes can share one data directory — e.g. multiple stdio
 * containers mounting the same `/data` volume — so installs and state-file
 * updates must be serialized across processes, not just within one.
 *
 * A lock whose file is older than `staleMs` is treated as abandoned (its
 * owner crashed or was killed) and taken over. PIDs are recorded for
 * diagnostics only: they are not comparable across containers.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FileLockOptions {
  /** Give up acquiring after this long. */
  readonly timeoutMs: number;
  /** Treat an existing lock older than this as abandoned. */
  readonly staleMs: number;
  /** Poll interval while waiting. */
  readonly pollMs?: number;
}

export type ReleaseLock = () => void;

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

function tryCreate(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    // Vanished between attempts: not stale, just retry the create.
    return false;
  }
}

/** Acquire `lockPath`, waiting up to `timeoutMs`. Resolves to a release function. */
export async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<ReleaseLock> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 200;

  for (;;) {
    if (tryCreate(lockPath)) {
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { force: true });
      };
    }
    if (isStale(lockPath, options.staleMs)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(lockPath, options.timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Run `fn` while holding `lockPath`. */
export async function withFileLock<T>(lockPath: string, options: FileLockOptions, fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    release();
  }
}
