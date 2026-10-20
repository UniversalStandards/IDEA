/**
 * tests/config-generator.test.ts
 * Unit tests for tool-scoped credential injection in
 * src/provisioning/config-generator.ts.
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { configGenerator, toolEnvPrefix, toolScopedEnv } from '../src/provisioning/config-generator';

const tool = {
  id: 'official:web-search',
  name: 'web-search',
  version: '1.0.0',
  description: 'd',
  source: 'official' as const,
  capabilities: [],
  tags: [],
};

describe('toolEnvPrefix()', () => {
  it('upper-cases the tool name and replaces non-alphanumerics', () => {
    expect(toolEnvPrefix('web-search')).toBe('TOOL_WEB_SEARCH__');
    expect(toolEnvPrefix('io.github.acme/widgets')).toBe('TOOL_IO_GITHUB_ACME_WIDGETS__');
  });
});

describe('toolScopedEnv()', () => {
  it('collects only this tool\'s variables, keyed by their unprefixed name', () => {
    expect(
      toolScopedEnv('web-search', {
        TOOL_WEB_SEARCH__BRAVE_API_KEY: 'k',
        TOOL_WEB_SEARCH__REGION: 'eu',
        TOOL_GITHUB__TOKEN: 'other-tool',
        TOOL_WEB_SEARCH__: 'no-name',
        'TOOL_WEB_SEARCH__BAD-NAME': 'invalid',
        JWT_SECRET: 'hub',
      }),
    ).toEqual({ BRAVE_API_KEY: 'k', REGION: 'eu' });
  });
});

describe('ConfigGenerator.generate()', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it('injects TOOL_<NAME>__<VAR> variables into the tool environment', () => {
    process.env = { ...original, TOOL_WEB_SEARCH__BRAVE_API_KEY: 'scoped' };
    const cfg = configGenerator.generate(tool, {});
    expect(cfg.env['BRAVE_API_KEY']).toBe('scoped');
  });

  it('lets explicit credentials win over scoped variables', () => {
    process.env = { ...original, TOOL_WEB_SEARCH__BRAVE_API_KEY: 'scoped' };
    const cfg = configGenerator.generate(tool, { BRAVE_API_KEY: 'explicit' });
    expect(cfg.env['BRAVE_API_KEY']).toBe('explicit');
  });
});
