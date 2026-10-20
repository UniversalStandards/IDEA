/**
 * tests/env.test.ts
 * src/env.ts must load .env without writing anything to stdout (stdout is the
 * MCP channel in stdio mode).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

describe('loadEnvironment()', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'HUB_ENV_TEST_VALUE=loaded\n');
    process.chdir(dir);
    delete process.env['HUB_ENV_TEST_VALUE'];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env['HUB_ENV_TEST_VALUE'];
  });

  it('loads .env from the working directory and writes nothing to stdout', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../src/env');
      });
      expect(process.env['HUB_ENV_TEST_VALUE']).toBe('loaded');
      expect(write).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });
});
