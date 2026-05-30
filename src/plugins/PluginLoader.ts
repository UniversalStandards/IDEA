import { readFile } from 'fs/promises';
import path from 'path';
import type { PluginApiHandlers } from './api/PluginApi';
import { PluginApi } from './api/PluginApi';
import { readPluginManifest, type PluginManifest } from './PluginManifest';
import { resolvePluginPermissionGrants } from './PluginPermissions';
import { PluginSandbox } from './PluginSandbox';

export type LoadedPlugin = {
  pluginPath: string;
  manifest: PluginManifest;
  sandbox: PluginSandbox;
  loadedAt: string;
};

export class PluginLoader {
  constructor(private readonly handlers: PluginApiHandlers = {}) {}

  async load(pluginPath: string): Promise<LoadedPlugin> {
    const manifestPath = path.join(pluginPath, 'idea-plugin.json');
    const manifest = await readPluginManifest(manifestPath);

    const entrypointPath = path.resolve(pluginPath, manifest.entrypoint);

    try {
      await import(entrypointPath);
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(entrypointPath);
    }

    const pluginCode = await readFile(entrypointPath, 'utf8');
    const grants = resolvePluginPermissionGrants(manifest.permissions);
    const sandbox = new PluginSandbox(manifest.name, pluginCode, new PluginApi(this.handlers), grants);

    await sandbox.initialize();

    return {
      pluginPath,
      manifest,
      sandbox,
      loadedAt: new Date().toISOString(),
    };
  }
}
