import vm from 'vm';
import { createLogger } from '../observability/logger';
import type { PluginHookName } from './PluginManifest';
import type { ResolvedPluginGrants } from './PluginPermissions';
import { PluginApi } from './api/PluginApi';

const logger = createLogger('plugin-sandbox');
const DEFAULT_HOOK_TIMEOUT_MS = 8_000;

type IsolatedVmModule = {
  Isolate: new (options?: { memoryLimit?: number }) => {
    createContext: () => Promise<{ global: { set: (name: string, value: unknown) => Promise<void>; derefInto: () => unknown } }>;
    dispose: () => void;
  };
  Reference: new (value: (...args: unknown[]) => unknown) => {
    apply: (
      receiver: unknown,
      args: unknown[],
      options?: { arguments?: { copy?: boolean }; result?: { copy?: boolean } },
    ) => Promise<unknown>;
  };
};

function loadIsolatedVm(): IsolatedVmModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('isolated-vm') as IsolatedVmModule;
  } catch {
    return null;
  }
}

function wrapPluginCode(pluginCode: string): string {
  return `
    globalThis.__pluginExports = (() => {
      const module = { exports: {} };
      const exports = module.exports;
      ${pluginCode}
      if (module.exports && module.exports.default) return module.exports.default;
      return module.exports;
    })();
  `;
}

export class PluginSandbox {
  private readonly scopedApi: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  private readonly isolatedVm = process.env['IDEA_PLUGIN_USE_ISOLATED_VM'] === 'true' ? loadIsolatedVm() : null;

  private isolate: { createContext: () => Promise<unknown>; dispose: () => void } | undefined;
  private context:
    | {
        eval: (code: string, options?: { timeout?: number }) => Promise<unknown>;
        global: { set: (name: string, value: unknown) => Promise<void>; derefInto: () => unknown };
      }
    | undefined;
  private vmContext: vm.Context | undefined;

  constructor(
    private readonly pluginName: string,
    private readonly pluginCode: string,
    private readonly pluginApi: PluginApi,
    private readonly grants: ResolvedPluginGrants,
  ) {
    this.scopedApi = pluginApi.createScopedApi(grants);
  }

  async initialize(): Promise<void> {
    if (this.isolatedVm) {
      await this.initializeWithIsolatedVm();
      return;
    }

    this.initializeWithNodeVm();
  }

  private async initializeWithIsolatedVm(): Promise<void> {
    const ivm = this.isolatedVm;
    if (!ivm) return;

    this.isolate = new ivm.Isolate({ memoryLimit: 64 });
    const context = await this.isolate.createContext();
    this.context = context as unknown as {
      eval: (code: string, options?: { timeout?: number }) => Promise<unknown>;
      global: { set: (name: string, value: unknown) => Promise<void>; derefInto: () => unknown };
    };

    const jail = this.context.global;
    await jail.set('globalThis', jail.derefInto());

    const hostCall = new ivm.Reference(async (...params: unknown[]) => {
      const [surface, method, args] = params;
      if (typeof surface !== 'string' || typeof method !== 'string' || !Array.isArray(args)) {
        throw new Error('Invalid plugin API bridge invocation');
      }
      return await this.pluginApi.invoke(surface as never, method, args, this.grants);
    });

    await jail.set('__hostCall', hostCall);
    await this.context.eval(
      `
      globalThis.__pluginApi = new Proxy({}, {
        get(_target, surface) {
          if (typeof surface !== 'string') return undefined;
          return new Proxy({}, {
            get(_sTarget, method) {
              if (typeof method !== 'string') return undefined;
              return (...args) => globalThis.__hostCall.apply(undefined, [surface, method, args], {
                arguments: { copy: true },
                result: { copy: true }
              });
            }
          });
        }
      });
    `,
    );

    await this.context.eval(wrapPluginCode(this.pluginCode));
  }

  private initializeWithNodeVm(): void {
    this.vmContext = vm.createContext({});
    const script = new vm.Script(wrapPluginCode(this.pluginCode), {
      filename: `${this.pluginName}.plugin.js`,
    });
    script.runInContext(this.vmContext, { timeout: DEFAULT_HOOK_TIMEOUT_MS });
  }

  async invokeHook(hook: PluginHookName, event: unknown): Promise<unknown> {
    if (this.context) {
      return await this.invokeWithIsolatedVm(hook, event);
    }

    return await this.invokeWithNodeVm(hook, event);
  }

  private async invokeWithIsolatedVm(hook: PluginHookName, event: unknown): Promise<unknown> {
    if (!this.context) return undefined;

    await this.context.global.set('__hookEvent', event);

    const hookCode = `
      (async () => {
        const mod = globalThis.__pluginExports;
        const fn = mod && mod[${JSON.stringify(hook)}];
        if (typeof fn !== 'function') return undefined;
        return await fn(globalThis.__hookEvent, globalThis.__pluginApi);
      })();
    `;

    return await this.context.eval(hookCode, { timeout: DEFAULT_HOOK_TIMEOUT_MS });
  }

  private async invokeWithNodeVm(hook: PluginHookName, event: unknown): Promise<unknown> {
    if (!this.vmContext) return undefined;

    const pluginExports = vm.runInContext('globalThis.__pluginExports', this.vmContext) as Record<string, unknown>;
    const hookFn = pluginExports?.[hook];
    if (typeof hookFn !== 'function') return undefined;

    const callFn = hookFn as (payload: unknown, api: unknown) => unknown;
    return await Promise.resolve(callFn(event, this.scopedApi));
  }

  async dispose(): Promise<void> {
    if (this.isolate) {
      this.isolate.dispose();
      this.isolate = undefined;
    }

    this.context = undefined;
    this.vmContext = undefined;
    logger.debug('Plugin sandbox disposed', { plugin: this.pluginName });
  }
}
