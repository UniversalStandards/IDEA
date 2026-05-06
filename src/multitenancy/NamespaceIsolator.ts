import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../observability/logger';

const logger = createLogger('namespace-isolator');
const ORG_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,61}[a-zA-Z0-9]$/; // 3-63 chars, must start/end alphanumeric

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys?(): string[];
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();

  get(key: string): unknown {
    return this.map.get(key);
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

export class NamespaceIsolator {
  constructor(
    private readonly db: KeyValueStore = new InMemoryKeyValueStore(),
    private readonly cache: KeyValueStore = new InMemoryKeyValueStore(),
    private readonly configRootDir: string = path.join(process.cwd(), 'config'),
  ) {}

  tenantDbKey(orgId: string, resource: string): string {
    this.assertOrgId(orgId);
    this.assertResource(resource);
    return `tenant:${orgId}:${resource}`;
  }

  tenantCacheKey(orgId: string, cacheKey: string): string {
    this.assertOrgId(orgId);
    this.assertResource(cacheKey);
    return `tc:${orgId}:${cacheKey}`;
  }

  tenantConfigPath(orgId: string): string {
    this.assertOrgId(orgId);
    return path.join(this.configRootDir, orgId, 'settings.yaml');
  }

  setDb(orgId: string, resource: string, value: unknown): void {
    const key = this.tenantDbKey(orgId, resource);
    this.db.set(key, value);
  }

  getDb<T>(orgId: string, resource: string): T | undefined {
    const key = this.tenantDbKey(orgId, resource);
    return this.db.get(key) as T | undefined;
  }

  deleteDb(orgId: string, resource: string): boolean {
    const key = this.tenantDbKey(orgId, resource);
    return this.db.delete(key);
  }

  listDbKeys(orgId: string): string[] {
    this.assertOrgId(orgId);
    const prefix = `tenant:${orgId}:`;
    return (this.db.keys?.() ?? []).filter((key) => key.startsWith(prefix));
  }

  setCache(orgId: string, cacheKey: string, value: unknown): void {
    this.cache.set(this.tenantCacheKey(orgId, cacheKey), value);
  }

  getCache<T>(orgId: string, cacheKey: string): T | undefined {
    return this.cache.get(this.tenantCacheKey(orgId, cacheKey)) as T | undefined;
  }

  deleteCache(orgId: string, cacheKey: string): boolean {
    return this.cache.delete(this.tenantCacheKey(orgId, cacheKey));
  }

  async writeTenantConfig(orgId: string, content: string): Promise<string> {
    const configPath = this.tenantConfigPath(orgId);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, content, 'utf8');
    logger.info('Tenant config written', { orgId, configPath });
    return configPath;
  }

  async readTenantConfig(orgId: string): Promise<string> {
    const configPath = this.tenantConfigPath(orgId);
    return readFile(configPath, 'utf8');
  }

  private assertOrgId(orgId: string): void {
    if (!ORG_ID_PATTERN.test(orgId)) {
      throw new Error(`Invalid orgId: '${orgId}'`);
    }
  }

  private assertResource(resource: string): void {
    if (!resource || resource.trim() === '') {
      throw new Error('Resource key must not be empty');
    }
    if (resource.startsWith('tenant:') || resource.startsWith('tc:')) {
      throw new Error('Resource must not contain tenant/cache namespace prefixes');
    }
    if (resource.includes('..')) {
      throw new Error('Resource must not contain path traversal segments');
    }
  }
}

export const namespaceIsolator = new NamespaceIsolator();
