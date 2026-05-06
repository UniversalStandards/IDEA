import { z } from 'zod';

export const RoleDefinitionSchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string().min(1)).default([]),
  inherits: z.array(z.string().min(1)).default([]),
});

export const RoleAssignmentSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  roles: z.array(z.string().min(1)).default([]),
});

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

function assignmentKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

export class RbacEngine {
  private readonly roles = new Map<string, RoleDefinition>();
  private readonly assignments = new Map<string, Set<string>>();
  private readonly permissionCache = new Map<string, Set<string>>();

  constructor(defaultRoles: RoleDefinition[] = []) {
    for (const role of defaultRoles) {
      this.registerRole(role);
    }
  }

  registerRole(role: RoleDefinition): void {
    const parsed = RoleDefinitionSchema.parse(role);

    for (const inherited of parsed.inherits) {
      if (inherited === parsed.name) {
        throw new Error(`Role '${parsed.name}' cannot inherit itself`);
      }
    }

    this.roles.set(parsed.name, {
      name: parsed.name,
      permissions: [...parsed.permissions],
      inherits: [...parsed.inherits],
    });
    this.clearCache();
  }

  registerRoles(roles: RoleDefinition[]): void {
    for (const role of roles) {
      this.registerRole(role);
    }
  }

  assignRole(orgId: string, userId: string, roleName: string): void {
    if (!this.roles.has(roleName)) {
      throw new Error(`Unknown role '${roleName}'`);
    }

    const key = assignmentKey(orgId, userId);
    const existing = this.assignments.get(key) ?? new Set<string>();
    existing.add(roleName);
    this.assignments.set(key, existing);
    this.permissionCache.delete(key);
  }

  revokeRole(orgId: string, userId: string, roleName: string): void {
    const key = assignmentKey(orgId, userId);
    const existing = this.assignments.get(key);
    if (!existing) {
      return;
    }

    existing.delete(roleName);
    if (existing.size === 0) {
      this.assignments.delete(key);
    }
    this.permissionCache.delete(key);
  }

  setUserRoles(assignment: RoleAssignment): void {
    const parsed = RoleAssignmentSchema.parse(assignment);
    for (const roleName of parsed.roles) {
      if (!this.roles.has(roleName)) {
        throw new Error(`Unknown role '${roleName}'`);
      }
    }

    const key = assignmentKey(parsed.orgId, parsed.userId);
    this.assignments.set(key, new Set(parsed.roles));
    this.permissionCache.delete(key);
  }

  getUserRoles(orgId: string, userId: string): string[] {
    const assigned = this.assignments.get(assignmentKey(orgId, userId));
    if (!assigned) {
      return [];
    }
    return Array.from(assigned.values()).sort();
  }

  resolvePermissions(orgId: string, userId: string): Set<string> {
    const key = assignmentKey(orgId, userId);
    const cached = this.permissionCache.get(key);
    if (cached) {
      return new Set(cached);
    }

    const assigned = this.assignments.get(key);
    if (!assigned || assigned.size === 0) {
      const empty = new Set<string>();
      this.permissionCache.set(key, empty);
      return new Set(empty);
    }

    const resolved = new Set<string>();
    const visited = new Set<string>();

    for (const roleName of assigned.values()) {
      this.collectRolePermissions(roleName, resolved, visited, []);
    }

    this.permissionCache.set(key, new Set(resolved));
    return resolved;
  }

  hasPermission(orgId: string, userId: string, permission: string): boolean {
    const permissions = this.resolvePermissions(orgId, userId);
    return permissions.has(permission) || permissions.has('*');
  }

  listRoles(): RoleDefinition[] {
    return Array.from(this.roles.values()).map((role) => ({
      name: role.name,
      permissions: [...role.permissions],
      inherits: [...role.inherits],
    }));
  }

  private collectRolePermissions(
    roleName: string,
    collector: Set<string>,
    visited: Set<string>,
    stack: string[],
  ): void {
    if (visited.has(roleName)) {
      return;
    }

    if (stack.includes(roleName)) {
      const chain = [...stack, roleName].join(' -> ');
      throw new Error(`RBAC role inheritance cycle detected: ${chain}`);
    }

    const role = this.roles.get(roleName);
    if (!role) {
      throw new Error(`Role '${roleName}' is not registered`);
    }

    const nextStack = [...stack, roleName];
    for (const inherited of role.inherits) {
      this.collectRolePermissions(inherited, collector, visited, nextStack);
    }

    for (const permission of role.permissions) {
      collector.add(permission);
    }

    visited.add(roleName);
  }

  private clearCache(): void {
    this.permissionCache.clear();
  }
}
