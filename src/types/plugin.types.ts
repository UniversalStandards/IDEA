export type PluginHook =
  | 'onCapabilityInstalled'
  | 'onWorkflowComplete'
  | 'onRouteSelected'
  | 'onAuditEvent';

export enum PluginStatus {
  LOADED = 'loaded',
  UNLOADED = 'unloaded',
  ERROR = 'error',
}

export enum PluginPermission {
  READ_AUDIT_LOG = 'read_audit_log',
  READ_CAPABILITIES = 'read_capabilities',
  EXECUTE_WORKFLOWS = 'execute_workflows',
  MANAGE_ROUTING = 'manage_routing',
}

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly permissions: PluginPermission[];
  readonly entrypoint: string;
  readonly hooks: PluginHook[];
}

export interface Plugin {
  readonly manifest: PluginManifest;
  readonly status: PluginStatus;
  readonly loadedAt: string;
  readonly instanceId: string;
}
