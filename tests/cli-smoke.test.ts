/**
 * tests/cli-smoke.test.ts
 * Argument parsing for the end-to-end smoke client (src/cli/smoke.ts). The
 * full flow runs in CI against the built image (see .github/workflows/ci.yml).
 */

import path from 'path';
import { parseArgs } from '../src/cli/smoke';

describe('parseArgs()', () => {
  const original = process.env['MCP_AUTH_TOKEN'];
  afterEach(() => {
    if (original === undefined) delete process.env['MCP_AUTH_TOKEN'];
    else process.env['MCP_AUTH_TOKEN'] = original;
  });

  it('defaults to stdio against this build', () => {
    delete process.env['MCP_AUTH_TOKEN'];
    const opts = parseArgs([]);
    expect(opts).toMatchObject({ mode: 'stdio', approve: false, keep: false, timeoutMs: 180_000 });
    expect(opts.serverEntry).toBe(path.resolve(__dirname, '..', 'src', 'index.js'));
    expect(opts).not.toHaveProperty('token');
    expect(opts).not.toHaveProperty('install');
  });

  it('parses HTTP mode, token, install, approval and persistence flags', () => {
    expect(
      parseArgs([
        '--http',
        'http://127.0.0.1:3000/mcp',
        '--token',
        'tok',
        '--install',
        'official:memory',
        '--approve',
        '--keep',
        '--expect-installed',
        'official:time',
        '--server',
        '/x/index.js',
        '--timeout',
        '5000',
      ]),
    ).toEqual({
      mode: 'http',
      url: 'http://127.0.0.1:3000/mcp',
      token: 'tok',
      install: 'official:memory',
      approve: true,
      keep: true,
      expectInstalled: 'official:time',
      serverEntry: '/x/index.js',
      timeoutMs: 5000,
    });
  });

  it('falls back to MCP_AUTH_TOKEN from the environment', () => {
    process.env['MCP_AUTH_TOKEN'] = 'from-env';
    expect(parseArgs(['--http', 'http://h/mcp']).token).toBe('from-env');
  });
});
