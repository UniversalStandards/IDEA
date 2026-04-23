/**
 * tests/dependency-resolver.test.ts
 * Unit tests for src/provisioning/dependency-resolver.ts
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { DependencyResolver } from '../src/provisioning/dependency-resolver';
import type { ToolMetadata } from '../src/discovery/types';

function baseTool(dependencies: string[] = []): ToolMetadata {
  return {
    id: 'tool-1',
    name: 'test-tool',
    version: '1.0.0',
    description: 'A test tool',
    source: 'local',
    capabilities: [],
    tags: [],
    dependencies,
  };
}

describe('DependencyResolver — resolve()', () => {
  let resolver: DependencyResolver;

  beforeEach(() => {
    resolver = new DependencyResolver();
  });

  it('returns empty arrays for a tool with no dependencies', () => {
    const result = resolver.resolve(baseTool());
    expect(result.packages).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.installOrder).toEqual([]);
  });

  it('returns empty arrays for a tool with undefined dependencies', () => {
    const tool = baseTool();
    delete tool.dependencies;
    const result = resolver.resolve(tool);
    expect(result.packages).toEqual([]);
  });

  it('parses a simple package without version', () => {
    const result = resolver.resolve(baseTool(['express']));
    expect(result.packages).toContain('express');
    expect(result.installOrder).toContain('express');
  });

  it('parses a package with version range', () => {
    const result = resolver.resolve(baseTool(['express@^4.18.0']));
    expect(result.packages).toContain('express@^4.18.0');
    expect(result.installOrder).toContain('express@^4.18.0');
  });

  it('parses a scoped package without version', () => {
    const result = resolver.resolve(baseTool(['@types/node']));
    expect(result.packages).toContain('@types/node');
    expect(result.installOrder).toContain('@types/node');
  });

  it('parses a scoped package with version', () => {
    const result = resolver.resolve(baseTool(['@modelcontextprotocol/sdk@^1.0.0']));
    expect(result.packages).toContain('@modelcontextprotocol/sdk@^1.0.0');
  });

  it('skips empty or whitespace-only dependency strings', () => {
    const result = resolver.resolve(baseTool(['  ', '', 'express']));
    expect(result.packages.length).toBe(1);
    expect(result.packages).toContain('express');
  });

  it('sorts scoped packages first in installOrder', () => {
    const result = resolver.resolve(baseTool(['express', '@types/node', 'zod']));
    const order = result.installOrder;
    const scopedIdx = order.findIndex((p) => p.startsWith('@'));
    const unscopedIdx = order.findIndex((p) => !p.startsWith('@'));
    if (scopedIdx >= 0 && unscopedIdx >= 0) {
      expect(scopedIdx).toBeLessThan(unscopedIdx);
    }
  });

  it('deduplicates packages in installOrder', () => {
    const result = resolver.resolve(baseTool(['express', 'express@^4.0.0']));
    const expressEntries = result.installOrder.filter((p) => p.startsWith('express'));
    expect(expressEntries.length).toBe(1);
  });

  it('detects conflicting version ranges', () => {
    const result = resolver.resolve(baseTool(['express@^3.0.0', 'express@^4.0.0']));
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]).toContain('express');
  });

  it('does not flag conflict for identical version ranges', () => {
    const result = resolver.resolve(baseTool(['lodash@^4.0.0', 'lodash@^4.0.0']));
    expect(result.conflicts.length).toBe(0);
  });

  it('does not flag conflict when one range is wildcard', () => {
    const result = resolver.resolve(baseTool(['express', 'express@^4.0.0']));
    // One has '*' range (bare name), no conflict expected
    expect(result.conflicts.length).toBe(0);
  });

  it('excludes conflicting packages from installOrder', () => {
    const result = resolver.resolve(baseTool(['express@^3.0.0', 'express@^4.0.0']));
    // Conflicting package should not appear in install order
    expect(result.installOrder.some((p) => p.startsWith('express'))).toBe(false);
  });

  it('handles multiple non-conflicting packages', () => {
    const result = resolver.resolve(baseTool(['express@^4.0.0', 'zod@^3.0.0', 'axios@^1.0.0']));
    expect(result.packages.length).toBe(3);
    expect(result.conflicts.length).toBe(0);
    expect(result.installOrder.length).toBe(3);
  });

  it('processes packages in alphabetical order within same type', () => {
    const result = resolver.resolve(baseTool(['zod', 'axios', 'express']));
    const order = result.installOrder;
    expect(order).toEqual([...order].sort((a, b) => a.localeCompare(b)));
  });

  it('handles unresolvable semver constraints', () => {
    // Use clearly invalid semver ranges that semver.intersects would throw or flag
    const result = resolver.resolve(baseTool(['pkg@not-valid', 'pkg@also-invalid']));
    // Should not throw, may or may not detect conflict depending on semver behaviour
    expect(Array.isArray(result.conflicts)).toBe(true);
  });

  it('returns all packages list including wildcard ones', () => {
    const result = resolver.resolve(baseTool(['express', 'zod@^3.0.0']));
    expect(result.packages).toContain('express');
    expect(result.packages).toContain('zod@^3.0.0');
  });
});
