import fs from 'fs';
import os from 'os';
import path from 'path';
import { VersionManager } from '../src/provisioning/VersionManager';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('VersionManager', () => {
  it('activates versions and rolls back to the previous working state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-version-manager-'));
    const manager = new VersionManager({
      installBaseDir: root,
      statePath: path.join(root, 'state.json'),
    });

    const v1Path = manager.prepareInstallDir('tool-a', '1.0.0');
    const v2Path = manager.prepareInstallDir('tool-a', '2.0.0');

    manager.stageVersion('tool-a', '1.0.0', v1Path);
    manager.activateVersion('tool-a', '1.0.0');
    manager.stageVersion('tool-a', '2.0.0', v2Path);
    manager.activateVersion('tool-a', '2.0.0');

    const rolledBack = manager.rollback('tool-a');

    expect(rolledBack.version).toBe('1.0.0');
    expect(manager.getActiveVersion('tool-a')?.version).toBe('1.0.0');
    expect(manager.getHistory('tool-a').map((entry) => entry.version)).toEqual(
      expect.arrayContaining(['1.0.0', '2.0.0']),
    );
  });

  it('rejects current pointers that escape the managed install root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-version-manager-'));
    const manager = new VersionManager({
      installBaseDir: root,
      statePath: path.join(root, 'state.json'),
    });

    manager.stageVersion('tool-a', '1.0.0', '/etc');

    expect(() => manager.activateVersion('tool-a', '1.0.0')).toThrow(
      'Install path escapes managed install root',
    );
  });
});
