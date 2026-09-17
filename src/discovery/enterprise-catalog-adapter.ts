/**
 * src/discovery/enterprise-catalog-adapter.ts
 * Adapts EnterpriseCatalogConnector (implements IRegistryConnector from
 * src/types/index.ts) to the Registry interface (src/discovery/types.ts)
 * that registry-manager.ts actually consumes.
 *
 * These are two distinct registry interfaces that already coexist in this
 * codebase — IRegistryConnector (discover()) vs Registry (search/getById/
 * list/isAvailable) — which is why the enterprise catalog was built but
 * never actually registered into the manager. This adapter is the bridge.
 */

import type { Registry, RegistrySearchOptions, ToolMetadata } from './types';
import { enterpriseCatalog } from './enterprise-catalog';
import type { DiscoveredTool } from '../types/index';

function toToolMetadata(tool: DiscoveredTool): ToolMetadata {
  return {
    id: tool.packageName ?? tool.name,
    name: tool.name,
    version: tool.version,
    description: tool.description,
    source: 'enterprise',
    repository: tool.repositoryUrl,
    capabilities: [],
    tags: tool.tags,
    verified: tool.trustScore !== undefined ? tool.trustScore >= 0.7 : undefined,
    metadata: tool.metadata,
  };
}

export class EnterpriseRegistryAdapter implements Registry {
  readonly name = 'enterprise-catalog';

  async isAvailable(): Promise<boolean> {
    return enterpriseCatalog.isEnabled();
  }

  async search(options: RegistrySearchOptions): Promise<ToolMetadata[]> {
    const tools = await enterpriseCatalog.discover(options.query);
    return tools.map(toToolMetadata);
  }

  async getById(id: string): Promise<ToolMetadata | null> {
    const all = await enterpriseCatalog.discover();
    const found = all.find((t) => (t.packageName ?? t.name) === id);
    return found ? toToolMetadata(found) : null;
  }

  async list(): Promise<ToolMetadata[]> {
    const tools = await enterpriseCatalog.discover();
    return tools.map(toToolMetadata);
  }
}
