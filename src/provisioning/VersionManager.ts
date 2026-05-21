import fs from 'fs';
import path from 'path';
import { createLogger } from '../observability/logger';

const logger = createLogger('version-manager');

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export type VersionState = 'staged' | 'active' | 'superseded' | 'failed' | 'rolled_back';

export interface VersionRecord {
  serverId: string;
  version: string;
  installPath: string;
  state: VersionState;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface VersionStore {
  activeVersion?: string;
  versions: VersionRecord[];
}

type VersionStateFile = Record<string, VersionStore>;

export class VersionManager {
  private readonly statePath: string;
  private readonly installBaseDir: string;

  constructor(options: { statePath?: string; installBaseDir?: string } = {}) {
    this.installBaseDir = options.installBaseDir ?? path.resolve(process.cwd(), '.mcp', 'installed');
    this.statePath = options.statePath ?? path.resolve(this.installBaseDir, 'version-state.json');
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
  }

  prepareInstallDir(serverId: string, version: string): string {
    const installDir = path.resolve(this.installBaseDir, sanitizePathSegment(serverId), sanitizePathSegment(version));
    fs.mkdirSync(installDir, { recursive: true });
    return installDir;
  }

  stageVersion(
    serverId: string,
    version: string,
    installPath: string,
    metadata: Record<string, unknown> = {},
  ): VersionRecord {
    const state = this.readState();
    const store = state[serverId] ?? { versions: [] };
    const now = new Date().toISOString();

    const existingIndex = store.versions.findIndex((entry) => entry.version === version);
    const record: VersionRecord = {
      serverId,
      version,
      installPath,
      state: 'staged',
      createdAt: store.versions[existingIndex]?.createdAt ?? now,
      updatedAt: now,
      metadata,
    };

    if (existingIndex >= 0) {
      store.versions[existingIndex] = record;
    } else {
      store.versions.push(record);
    }

    state[serverId] = store;
    this.writeState(state);
    logger.info('Staged version for provisioning', { serverId, version, installPath });
    return record;
  }

  activateVersion(serverId: string, version: string, metadata: Record<string, unknown> = {}): VersionRecord {
    const state = this.readState();
    const store = state[serverId];
    if (!store) {
      throw new Error(`Unknown server for activation: ${serverId}`);
    }

    const target = store.versions.find((entry) => entry.version === version);
    if (!target) {
      throw new Error(`Unknown version ${version} for ${serverId}`);
    }

    const now = new Date().toISOString();
    for (const entry of store.versions) {
      if (entry.version === version) {
        entry.state = 'active';
        entry.updatedAt = now;
        entry.metadata = { ...entry.metadata, ...metadata };
      } else if (entry.state === 'active') {
        entry.state = 'superseded';
        entry.updatedAt = now;
      }
    }

    store.activeVersion = version;
    state[serverId] = store;
    this.writeState(state);
    this.writeCurrentPointer(serverId, target.installPath);
    logger.info('Activated server version', { serverId, version });
    return target;
  }

  markFailed(serverId: string, version: string, reason: string): VersionRecord {
    const state = this.readState();
    const store = state[serverId];
    if (!store) {
      throw new Error(`Unknown server for failure tracking: ${serverId}`);
    }

    const target = store.versions.find((entry) => entry.version === version);
    if (!target) {
      throw new Error(`Unknown version ${version} for ${serverId}`);
    }

    target.state = 'failed';
    target.updatedAt = new Date().toISOString();
    target.metadata = { ...target.metadata, failureReason: reason };
    this.writeState(state);
    logger.warn('Marked version as failed', { serverId, version, reason });
    return target;
  }

  rollback(serverId: string, version?: string): VersionRecord {
    const state = this.readState();
    const store = state[serverId];
    if (!store) {
      throw new Error(`Unknown server for rollback: ${serverId}`);
    }

    const candidates = [...store.versions]
      .filter((entry) => entry.state === 'active' || entry.state === 'superseded' || entry.version === version)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const currentActive = store.activeVersion;
    const target = version
      ? store.versions.find((entry) => entry.version === version)
      : candidates.find((entry) => entry.version !== currentActive);

    if (!target) {
      throw new Error(`No rollback target available for ${serverId}`);
    }

    const now = new Date().toISOString();
    for (const entry of store.versions) {
      if (entry.version === target.version) {
        entry.state = 'active';
        entry.updatedAt = now;
      } else if (entry.version === currentActive) {
        entry.state = 'rolled_back';
        entry.updatedAt = now;
      }
    }

    store.activeVersion = target.version;
    this.writeState(state);
    this.writeCurrentPointer(serverId, target.installPath);
    logger.warn('Rolled back server version', { serverId, version: target.version });
    return target;
  }

  getActiveVersion(serverId: string): VersionRecord | undefined {
    const state = this.readState();
    const store = state[serverId];
    if (!store?.activeVersion) {
      return undefined;
    }
    return store.versions.find((entry) => entry.version === store.activeVersion);
  }

  getVersion(serverId: string, version: string): VersionRecord | undefined {
    return this.readState()[serverId]?.versions.find((entry) => entry.version === version);
  }

  getHistory(serverId: string): VersionRecord[] {
    return [...(this.readState()[serverId]?.versions ?? [])].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  removeVersion(serverId: string, version: string): void {
    const state = this.readState();
    const store = state[serverId];
    if (!store) {
      return;
    }

    store.versions = store.versions.filter((entry) => entry.version !== version);
    if (store.activeVersion === version) {
      delete store.activeVersion;
    }
    this.writeState(state);
  }

  getInstallRoot(serverId: string): string {
    return path.resolve(this.installBaseDir, sanitizePathSegment(serverId));
  }

  private currentPointerPath(serverId: string): string {
    return path.resolve(this.getInstallRoot(serverId), 'current');
  }

  private writeCurrentPointer(serverId: string, installPath: string): void {
    const pointer = this.currentPointerPath(serverId);
    const normalizedInstallPath = path.resolve(installPath);
    if (!isPathWithin(this.installBaseDir, normalizedInstallPath)) {
      throw new Error(`Install path escapes managed install root: ${installPath}`);
    }
    fs.mkdirSync(path.dirname(pointer), { recursive: true });

    try {
      const stats = fs.lstatSync(pointer);
      if (stats.isSymbolicLink() || stats.isFile()) {
        fs.unlinkSync(pointer);
      }
    } catch {
      // Nothing to remove.
    }

    try {
      fs.symlinkSync(
        normalizedInstallPath,
        pointer,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      logger.warn('Falling back to file-based current pointer', {
        serverId,
        installPath: normalizedInstallPath,
        error: error instanceof Error ? error.message : String(error),
      });
      fs.writeFileSync(pointer, normalizedInstallPath, 'utf8');
    }
  }

  private readState(): VersionStateFile {
    if (!fs.existsSync(this.statePath)) {
      return {};
    }

    const raw = fs.readFileSync(this.statePath, 'utf8').trim();
    return raw ? (JSON.parse(raw) as VersionStateFile) : {};
  }

  private writeState(state: VersionStateFile): void {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }
}

export const versionManager = new VersionManager();
