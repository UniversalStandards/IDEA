/**
 * tests/version.test.ts
 * getServiceVersion() must track package.json (the MCP server advertises it to clients).
 */

import fs from 'fs';
import path from 'path';
import { getServiceVersion } from '../src/version';

describe('getServiceVersion()', () => {
  it('returns the version field of package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(getServiceVersion()).toBe(pkg.version);
  });

  it('returns the same value on repeated calls', () => {
    expect(getServiceVersion()).toBe(getServiceVersion());
  });

  it('falls back to 0.0.0 when package.json is unreadable or malformed', () => {
    jest.isolateModules(() => {
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../src/version') as typeof import('../src/version');

      expect(fresh.getServiceVersion()).toBe('0.0.0');
      spy.mockRestore();
    });

    jest.isolateModules(() => {
      const spy = jest.spyOn(fs, 'readFileSync').mockReturnValue('{"name":"x"}');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../src/version') as typeof import('../src/version');

      expect(fresh.getServiceVersion()).toBe('0.0.0');
      spy.mockRestore();
    });
  });
});
