import * as semver from 'semver';
import { createLogger } from '../observability/logger';
import { type ToolMetadata } from '../discovery/types';

const logger = createLogger('dependency-resolver');

export interface ResolvedDependencies {
  packages: string[];
  conflicts: string[];
  installOrder: string[];
}

interface ParsedDep {
  name: string;
  versionRange: string;
}

function parseDependency(dep: string): ParsedDep | null {
  const trimmed = dep.trim();
  if (!trimmed) return null;

  // Format: "@scope/name@version", "name@version", or just "name"
  const scopedMatch = /^(@[^@/]+\/[^@]+)(?:@(.+))?$/.exec(trimmed);
  if (scopedMatch) {
    return {
      name: scopedMatch[1]!,
      versionRange: scopedMatch[2] ?? '*',
    };
  }

  const atIdx = trimmed.indexOf('@');
  if (atIdx > 0) {
    return {
      name: trimmed.slice(0, atIdx),
      versionRange: trimmed.slice(atIdx + 1),
    };
  }

  return { name: trimmed, versionRange: '*' };
}

function detectConflicts(deps: ParsedDep[]): string[] {
  const byName = new Map<string, string[]>();

  for (const dep of deps) {
    const existing = byName.get(dep.name) ?? [];
    existing.push(dep.versionRange);
    byName.set(dep.name, existing);
  }

  const conflicts: string[] = [];

  for (const [name, ranges] of byName.entries()) {
    if (ranges.length <= 1) continue;

    const uniqueRanges = [...new Set(ranges)];
    if (uniqueRanges.length <= 1) continue;

    // Check if all version ranges are compatible
    let allCompatible = true;
    for (let i = 0; i < uniqueRanges.length - 1; i++) {
      for (let j = i + 1; j < uniqueRanges.length; j++) {
        const a = uniqueRanges[i]!;
        const b = uniqueRanges[j]!;

        if (a === '*' || b === '*') continue;

        try {
          const intersect = semver.intersects(a, b, { includePrerelease: false });
          if (!intersect) {
            allCompatible = false;
            conflicts.push(
              `Conflicting version ranges for ${name}: ${uniqueRanges.join(' vs ')}`,
            );
            break;
          }
        } catch {
          // If semver can't parse, flag as potential conflict
          conflicts.push(
            `Unresolvable version constraint for ${name}: ${uniqueRanges.join(' vs ')}`,
          );
          allCompatible = false;
        }
      }
      if (!allCompatible) break;
    }
  }

  return conflicts;
}

function buildInstallOrder(deps: ParsedDep[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  // Sort: scoped packages first (they tend to be frameworks/providers),
  // then alphabetically for determinism
  const sorted = [...deps].sort((a, b) => {
    const aScoped = a.name.startsWith('@') ? 0 : 1;
    const bScoped = b.name.startsWith('@') ? 0 : 1;
    if (aScoped !== bScoped) return aScoped - bScoped;
    return a.name.localeCompare(b.name);
  });

  for (const dep of sorted) {
    const spec =
      dep.versionRange && dep.versionRange !== '*'
        ? `${dep.name}@${dep.versionRange}`
        : dep.name;

    if (!seen.has(dep.name)) {
      seen.add(dep.name);
      order.push(spec);
    }
  }

  return order;
}

export class DependencyResolver {
  resolve(tool: ToolMetadata): ResolvedDependencies {
    logger.debug('Resolving dependencies', { toolId: tool.id });

    const rawDeps: string[] = tool.dependencies ?? [];
    const parsed: ParsedDep[] = [];

    for (const raw of rawDeps) {
      const dep = parseDependency(raw);
      if (dep) {
        parsed.push(dep);
      } else {
        logger.warn('Skipping unparseable dependency', { toolId: tool.id, raw });
      }
    }

    const conflicts = detectConflicts(parsed);

    if (conflicts.length > 0) {
      logger.warn('Dependency conflicts detected', { toolId: tool.id, conflicts });
    }

    const installOrder = buildInstallOrder(
      parsed.filter((d) => !conflicts.some((c) => c.includes(d.name))),
    );

    const packages = parsed.map((d) =>
      d.versionRange && d.versionRange !== '*'
        ? `${d.name}@${d.versionRange}`
        : d.name,
    );

    logger.info('Dependencies resolved', {
      toolId: tool.id,
      packageCount: packages.length,
      conflicts: conflicts.length,
      installOrderLength: installOrder.length,
    });

    return { packages, conflicts, installOrder };
  }
}

export const dependencyResolver = new DependencyResolver();
