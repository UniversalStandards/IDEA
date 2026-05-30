import { performance } from 'perf_hooks';
import { createLogger } from '../observability/logger';
import { readPluginManifest, type PluginHookName, type PluginManifest } from './PluginManifest';
import { PluginLoader, type LoadedPlugin } from './PluginLoader';
import { PluginStore, type PluginLifecycleState } from './PluginStore';

const logger = createLogger('plugin-manager');

export type ManagedPlugin = LoadedPlugin & {
  state: PluginLifecycleState;
};

export type HookDispatchResult = {
  pluginName: string;
  hook: PluginHookName;
  success: boolean;
  dispatchDelayMs: number;
  durationMs: number;
  result?: unknown;
  error?: string;
};

export class PluginManager {
  private readonly loadedPlugins = new Map<string, ManagedPlugin>();

  constructor(
    private readonly loader: PluginLoader,
    private readonly store?: PluginStore,
  ) {}

  async install(pluginPath: string): Promise<PluginManifest> {
    const manifest = await readPluginManifest(`${pluginPath}/idea-plugin.json`);
    await this.persist(manifest, pluginPath, 'installed');
    return manifest;
  }

  async load(pluginPath: string): Promise<ManagedPlugin> {
    const loaded = await this.loader.load(pluginPath);
    const managed: ManagedPlugin = { ...loaded, state: 'loaded' };
    this.loadedPlugins.set(loaded.manifest.name, managed);
    await this.persist(loaded.manifest, pluginPath, managed.state);
    return managed;
  }

  async start(pluginName: string): Promise<void> {
    const plugin = this.getRequired(pluginName);
    plugin.state = 'started';
    await this.persist(plugin.manifest, plugin.pluginPath, plugin.state);
  }

  async stop(pluginName: string): Promise<void> {
    const plugin = this.getRequired(pluginName);
    plugin.state = 'stopped';
    await this.persist(plugin.manifest, plugin.pluginPath, plugin.state);
  }

  async unload(pluginName: string): Promise<void> {
    const plugin = this.getRequired(pluginName);
    await plugin.sandbox.dispose();
    plugin.state = 'unloaded';
    await this.persist(plugin.manifest, plugin.pluginPath, plugin.state);
    this.loadedPlugins.delete(pluginName);
  }

  async update(pluginPath: string): Promise<ManagedPlugin> {
    const manifest = await readPluginManifest(`${pluginPath}/idea-plugin.json`);
    const existing = this.loadedPlugins.get(manifest.name);
    const wasStarted = existing?.state === 'started';

    if (existing) {
      await this.unload(existing.manifest.name);
    }

    const loaded = await this.load(pluginPath);
    if (wasStarted) {
      await this.start(loaded.manifest.name);
    }

    return this.getRequired(loaded.manifest.name);
  }

  async triggerHook(hook: PluginHookName, event: unknown): Promise<HookDispatchResult[]> {
    const startedPlugins = Array.from(this.loadedPlugins.values()).filter(
      (plugin) => plugin.state === 'started' && plugin.manifest.hooks.includes(hook),
    );

    const results: HookDispatchResult[] = [];

    for (const plugin of startedPlugins) {
      const dispatchStart = performance.now();
      const invokePromise = plugin.sandbox.invokeHook(hook, event);
      const dispatchDelayMs = performance.now() - dispatchStart;
      const hookStart = performance.now();

      try {
        const result = await invokePromise;
        const durationMs = performance.now() - hookStart;
        results.push({
          pluginName: plugin.manifest.name,
          hook,
          success: true,
          result,
          dispatchDelayMs,
          durationMs,
        });
      } catch (err) {
        const durationMs = performance.now() - hookStart;
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Plugin hook execution failed', {
          plugin: plugin.manifest.name,
          hook,
          err: message,
        });
        results.push({
          pluginName: plugin.manifest.name,
          hook,
          success: false,
          dispatchDelayMs,
          durationMs,
          error: message,
        });
      }
    }

    return results;
  }

  listLoaded(): ManagedPlugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  private getRequired(pluginName: string): ManagedPlugin {
    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin is not loaded: ${pluginName}`);
    }
    return plugin;
  }

  private async persist(manifest: PluginManifest, pluginPath: string, state: PluginLifecycleState): Promise<void> {
    if (!this.store) return;

    await this.store.upsert({
      name: manifest.name,
      version: manifest.version,
      pluginPath,
      state,
      updatedAt: new Date().toISOString(),
    });
  }
}
