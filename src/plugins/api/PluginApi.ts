import { PluginApiSurfaceName, type ResolvedPluginGrants } from '../PluginPermissions';

export type PluginApiHandlers = {
  discovery?: {
    listCapabilities?: () => unknown | Promise<unknown>;
    getCapabilityById?: (id: string) => unknown | Promise<unknown>;
  };
  routing?: {
    observeRoute?: (payload: unknown) => unknown | Promise<unknown>;
    getLastRoute?: () => unknown | Promise<unknown>;
  };
  observability?: {
    getMetricsSnapshot?: () => unknown | Promise<unknown>;
  };
  workflow?: {
    getLastWorkflowResult?: () => unknown | Promise<unknown>;
  };
  audit?: {
    listAuditEvents?: () => unknown | Promise<unknown>;
  };
  health?: {
    getProviderHealth?: () => unknown | Promise<unknown>;
  };
};

export class PluginPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPermissionError';
  }
}

export class PluginApi {
  constructor(private readonly handlers: PluginApiHandlers = {}) {}

  async invoke(
    surface: PluginApiSurfaceName,
    method: string,
    args: unknown[],
    grants: ResolvedPluginGrants,
  ): Promise<unknown> {
    if (!grants[surface].has(method)) {
      throw new PluginPermissionError(`Permission denied: ${surface}.${method}`);
    }

    const surfaceHandlers = this.handlers[surface] as Record<string, (...fnArgs: unknown[]) => unknown> | undefined;
    const handler = surfaceHandlers?.[method];
    if (typeof handler !== 'function') {
      throw new Error(`API method unavailable: ${surface}.${method}`);
    }

    return await Promise.resolve(handler(...args));
  }

  createScopedApi(grants: ResolvedPluginGrants): Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> {
    const scoped: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};

    for (const [surface, methods] of Object.entries(grants)) {
      if (methods.size === 0) continue;

      const scopedSurface: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const method of methods) {
        scopedSurface[method] = async (...args: unknown[]): Promise<unknown> =>
          this.invoke(surface as PluginApiSurfaceName, method, args, grants);
      }

      scoped[surface] = scopedSurface;
    }

    return scoped;
  }
}
