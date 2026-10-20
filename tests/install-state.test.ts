/**
 * tests/install-state.test.ts
 * Unit tests for src/provisioning/install-state.ts.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { InstallStateStore, type InstalledRecord } from '../src/provisioning/install-state';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const record: InstalledRecord = {
  tool: {
    id: 'official:memory',
    name: 'memory',
    version: '1.0.0',
    description: 'Memory',
    source: 'official',
    installCommand: 'npx -y @modelcontextprotocol/server-memory',
    capabilities: ['store'],
    tags: ['memory'],
    metadata: { anything: 1 },
  },
  args: ['--flag'],
  installPath: '/data/.mcp/installed/memory',
  installedAt: '2026-01-01T00:00:00.000Z',
};

describe('InstallStateStore', () => {
  it('returns an empty list when no state file exists', () => {
    expect(new InstallStateStore(path.join(dir, 'none.json')).load()).toEqual([]);
  });

  it('round-trips records through an atomic, owner-only file', () => {
    const file = path.join(dir, 'nested', 'state.json');
    const store = new InstallStateStore(file);

    store.save([record]);

    expect(store.getFilePath()).toBe(file);
    expect(store.load()).toEqual([record]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('ignores a file with the wrong schema', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ version: 99, tools: [] }));
    expect(new InstallStateStore(file).load()).toEqual([]);
  });

  it('ignores a file that is not JSON', () => {
    const file = path.join(dir, 'garbage.json');
    fs.writeFileSync(file, '{not json');
    expect(new InstallStateStore(file).load()).toEqual([]);
  });
});
