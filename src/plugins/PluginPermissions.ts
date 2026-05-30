export const ALLOWED_PLUGIN_PERMISSIONS = [
  'discovery:read',
  'routing:observe',
  'observability:metrics:read',
  'workflow:read',
  'audit:read',
  'health:read',
] as const;

export type PluginPermission = (typeof ALLOWED_PLUGIN_PERMISSIONS)[number];

export type PluginApiSurfaceName =
  | 'discovery'
  | 'routing'
  | 'observability'
  | 'workflow'
  | 'audit'
  | 'health';

export type PermissionGrant = {
  surface: PluginApiSurfaceName;
  methods: readonly string[];
};

const PERMISSION_GRANTS: Record<PluginPermission, readonly PermissionGrant[]> = {
  'discovery:read': [{ surface: 'discovery', methods: ['listCapabilities', 'getCapabilityById'] }],
  'routing:observe': [{ surface: 'routing', methods: ['observeRoute', 'getLastRoute'] }],
  'observability:metrics:read': [{ surface: 'observability', methods: ['getMetricsSnapshot'] }],
  'workflow:read': [{ surface: 'workflow', methods: ['getLastWorkflowResult'] }],
  'audit:read': [{ surface: 'audit', methods: ['listAuditEvents'] }],
  'health:read': [{ surface: 'health', methods: ['getProviderHealth'] }],
};

export type ResolvedPluginGrants = Record<PluginApiSurfaceName, Set<string>>;

export function resolvePluginPermissionGrants(permissions: readonly PluginPermission[]): ResolvedPluginGrants {
  const grants: ResolvedPluginGrants = {
    discovery: new Set<string>(),
    routing: new Set<string>(),
    observability: new Set<string>(),
    workflow: new Set<string>(),
    audit: new Set<string>(),
    health: new Set<string>(),
  };

  for (const permission of permissions) {
    for (const grant of PERMISSION_GRANTS[permission]) {
      for (const method of grant.methods) {
        grants[grant.surface].add(method);
      }
    }
  }

  return grants;
}

export function isPermissionAllowed(permission: string): permission is PluginPermission {
  return (ALLOWED_PLUGIN_PERMISSIONS as readonly string[]).includes(permission);
}
