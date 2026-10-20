/**
 * tests/file-lock.test.ts
 * Unit tests for the cross-process advisory lock (src/provisioning/file-lock.ts).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireFileLock, LockTimeoutError, withFileLock } from '../src/provisioning/file-lock';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('file lock', () => {
  it('creates the lock file (and parent dirs) and removes it on release, idempotently', async () => {
    const lockPath = path.join(dir, 'nested', 'a.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 1_000, staleMs: 60_000 });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toMatchObject({ pid: process.pid });
    release();
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes critical sections', async () => {
    const lockPath = path.join(dir, 'b.lock');
    const events: string[] = [];
    const section = (name: string) => () =>
      withFileLock(lockPath, { timeoutMs: 5_000, staleMs: 60_000, pollMs: 5 }, async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`${name}:end`);
        return name;
      });
    const results = await Promise.all([section('one')(), section('two')()]);
    expect(results).toEqual(['one', 'two']);
    expect(events[1]).toMatch(/:end$/);
    expect(events[2]).toMatch(/:start$/);
  });

  it('releases the lock when the critical section throws', async () => {
    const lockPath = path.join(dir, 'c.lock');
    await expect(
      withFileLock(lockPath, { timeoutMs: 1_000, staleMs: 60_000 }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('times out while another holder keeps the lock', async () => {
    const lockPath = path.join(dir, 'd.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 1_000, staleMs: 60_000 });
    try {
      await expect(acquireFileLock(lockPath, { timeoutMs: 60, staleMs: 60_000, pollMs: 10 })).rejects.toBeInstanceOf(
        LockTimeoutError,
      );
    } finally {
      release();
    }
  });

  it('takes over an abandoned (stale) lock', async () => {
    const lockPath = path.join(dir, 'e.lock');
    fs.writeFileSync(lockPath, '{"pid":1}');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    const release = await acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 60_000 });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toMatchObject({ pid: process.pid });
    release();
  });

  it('propagates unexpected filesystem errors', async () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    await expect(acquireFileLock(path.join(blocker, 'sub', 'f.lock'), { timeoutMs: 100, staleMs: 1_000 })).rejects.toThrow();
  });
});
