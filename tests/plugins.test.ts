import { mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AxiosInstance } from 'axios';
import { validatePluginManifest } from '../src/plugins/PluginManifest';
import { PluginLoader } from '../src/plugins/PluginLoader';
import { PluginManager } from '../src/plugins/PluginManager';
import { PluginRegistry } from '../src/plugins/PluginRegistry';
import { PluginStore } from '../src/plugins/PluginStore';

let testCounter = 0;

async function createPluginFixture(options: {
  version: string;
  permissions: string[];
  hooks: string[];
  entrySource: string;
}): Promise<string> {
  testCounter += 1;
  const pluginDir = path.join(os.tmpdir(), `idea-plugin-${testCounter}`);
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true });

  const manifest = {
    name: `test-plugin-${testCounter}`,
    version: options.version,
    permissions: options.permissions,
    entrypoint: 'dist/index.js',
    hooks: options.hooks,
  };

  await writeFile(path.join(pluginDir, 'idea-plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(pluginDir, 'dist', 'index.js'), options.entrySource, 'utf8');

  return pluginDir;
}

describe('Plugin system', () => {
  it('validates manifest and rejects invalid permissions', () => {
    expect(
      validatePluginManifest({
        name: 'my-plugin',
        version: '1.0.0',
        permissions: ['discovery:read'],
        entrypoint: 'dist/index.js',
        hooks: ['onWorkflowComplete'],
      }),
    ).toMatchObject({ name: 'my-plugin' });

    expect(() =>
      validatePluginManifest({
        name: 'my-plugin',
        version: '1.0.0',
        permissions: ['root:admin'],
        entrypoint: 'dist/index.js',
        hooks: ['onWorkflowComplete'],
      }),
    ).toThrow();
  });

  it('blocks unauthorized sandbox API access without crashing manager', async () => {
    const pluginDir = await createPluginFixture({
      version: '1.0.0',
      permissions: ['discovery:read'],
      hooks: ['onWorkflowComplete'],
      entrySource: `
        module.exports = {
          onWorkflowComplete: async (_event, api) => {
            return api.routing.observeRoute({ provider: 'forbidden' });
          }
        }
      `,
    });

    const loader = new PluginLoader({
      discovery: {
        listCapabilities: () => ['capability-a'],
      },
    });

    const manager = new PluginManager(loader);
    const loaded = await manager.load(pluginDir);
    await manager.start(loaded.manifest.name);

    const results = await manager.triggerHook('onWorkflowComplete', { id: 'wf-1' });

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain('observeRoute');
  });

  it('blocks sandbox escape attempts to process globals', async () => {
    const pluginDir = await createPluginFixture({
      version: '1.0.0',
      permissions: ['discovery:read'],
      hooks: ['onWorkflowComplete'],
      entrySource: `
        module.exports = {
          onWorkflowComplete: async () => {
            return process.env;
          }
        }
      `,
    });

    const manager = new PluginManager(new PluginLoader());
    const loaded = await manager.load(pluginDir);
    await manager.start(loaded.manifest.name);
    const results = await manager.triggerHook('onWorkflowComplete', {});

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain('process');
  });

  it('supports hot update lifecycle without restart', async () => {
    const pluginDir = await createPluginFixture({
      version: '1.0.0',
      permissions: ['discovery:read'],
      hooks: ['onWorkflowComplete'],
      entrySource: `
        module.exports = {
          onWorkflowComplete: async (_event, api) => {
            const caps = await api.discovery.listCapabilities();
            return caps[0];
          }
        }
      `,
    });

    let capabilities = ['v1'];
    const loader = new PluginLoader({
      discovery: {
        listCapabilities: () => capabilities,
      },
    });

    const manager = new PluginManager(loader);

    const loaded = await manager.load(pluginDir);
    await manager.start(loaded.manifest.name);

    const firstRun = await manager.triggerHook('onWorkflowComplete', {});
    expect(firstRun[0]?.result).toBe('v1');
    expect(firstRun[0]?.dispatchDelayMs ?? 100).toBeLessThan(10);

    await writeFile(
      path.join(pluginDir, 'idea-plugin.json'),
      JSON.stringify(
        {
          ...loaded.manifest,
          version: '1.0.1',
        },
        null,
        2,
      ),
      'utf8',
    );

    await writeFile(
      path.join(pluginDir, 'dist', 'index.js'),
      `
        module.exports = {
          onWorkflowComplete: async (_event, api) => {
            const caps = await api.discovery.listCapabilities();
            return caps[0];
          }
        }
      `,
      'utf8',
    );

    capabilities = ['v2'];
    await manager.update(pluginDir);
    const secondRun = await manager.triggerHook('onWorkflowComplete', {});

    expect(secondRun[0]?.result).toBe('v2');
  });

  it('discovers community plugins by keyword', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        items: [
          {
            full_name: 'acme/idea-plugin-hello',
            name: 'idea-plugin-hello',
            description: 'hello world plugin',
            html_url: 'https://github.com/acme/idea-plugin-hello',
            stargazers_count: 42,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });

    const registry = new PluginRegistry({ get } as unknown as AxiosInstance);
    const results = await registry.search('hello');

    expect(get).toHaveBeenCalled();
    expect(results[0]?.fullName).toBe('acme/idea-plugin-hello');
  });

  it('persists plugin state to sqlite plugins table', async () => {
    testCounter += 1;
    const dbPath = path.join(os.tmpdir(), `idea-plugin-store-${testCounter}.sqlite`);

    await rm(dbPath, { force: true });

    const store = new PluginStore(dbPath);
    await store.initialize();

    await store.upsert({
      name: 'persisted-plugin',
      version: '1.0.0',
      pluginPath: '/tmp/persisted-plugin',
      state: 'loaded',
      updatedAt: new Date().toISOString(),
    });

    const stored = await store.get('persisted-plugin');
    expect(stored?.name).toBe('persisted-plugin');

    const list = await store.list();
    expect(list).toHaveLength(1);

    await store.close();
  });
});
