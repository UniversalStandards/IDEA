import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../observability/logger';
import type { NamespaceIsolator } from './NamespaceIsolator';
import type { TenantManager } from './TenantManager';

const logger = createLogger('tenant-provisioner');

export type TenantProvisionInput = {
  orgId: string;
  name: string;
  ownerUserId: string;
  apiKey?: string;
};

export type TenantProvisionResult = {
  orgId: string;
  durationMs: number;
  initializedResources: string[];
};

const DEFAULT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export class TenantProvisioner {
  constructor(
    private readonly manager: TenantManager,
    private readonly namespaceIsolator: NamespaceIsolator,
    private readonly policyRootDir: string = path.join(process.cwd(), 'policies'),
  ) {}

  async provision(input: TenantProvisionInput): Promise<TenantProvisionResult> {
    const startedAt = Date.now();

    const tenant = await this.manager.create({ orgId: input.orgId, name: input.name });

    if (input.apiKey) {
      await this.manager.registerApiKey(tenant.orgId, input.apiKey);
    }

    const defaultWorkspace = tenant.workspaces.find((workspace) => workspace.isDefault);
    if (!defaultWorkspace) {
      throw new Error(`Default workspace missing for tenant ${tenant.orgId}`);
    }

    await this.namespaceIsolator.writeTenantConfig(
      tenant.orgId,
      [
        `orgId: ${tenant.orgId}`,
        `name: ${tenant.name}`,
        'quotas:',
        '  requestsPerMinute: 300',
        '  members: 100',
        '  workspaces: 10',
      ].join('\n') + '\n',
    );

    this.namespaceIsolator.setDb(tenant.orgId, 'capabilities', []);
    this.namespaceIsolator.setDb(tenant.orgId, 'audit_log', []);
    this.namespaceIsolator.setDb(tenant.orgId, 'roles', DEFAULT_ROLES);
    this.namespaceIsolator.setDb(tenant.orgId, 'billing', { dailyUsageUsd: 0, monthlyUsageUsd: 0 });

    this.namespaceIsolator.setCache(tenant.orgId, 'quota', {
      maxRequestsPerMinute: 300,
      maxMembers: 100,
      maxWorkspaces: 10,
    });

    await this.manager.addMembership({
      orgId: tenant.orgId,
      workspaceId: defaultWorkspace.id,
      userId: input.ownerUserId,
      role: 'owner',
    });

    await this.writeDefaultPolicyFile(tenant.orgId);

    const durationMs = Date.now() - startedAt;
    if (durationMs > 2_000) {
      throw new Error(`Tenant provisioning exceeded SLA (2s): ${durationMs}ms`);
    }

    logger.info('Tenant provisioned', { orgId: tenant.orgId, durationMs });

    return {
      orgId: tenant.orgId,
      durationMs,
      initializedResources: [
        this.namespaceIsolator.tenantDbKey(tenant.orgId, 'capabilities'),
        this.namespaceIsolator.tenantDbKey(tenant.orgId, 'audit_log'),
        this.namespaceIsolator.tenantDbKey(tenant.orgId, 'roles'),
        this.namespaceIsolator.tenantCacheKey(tenant.orgId, 'quota'),
        this.namespaceIsolator.tenantConfigPath(tenant.orgId),
      ],
    };
  }

  private async writeDefaultPolicyFile(orgId: string): Promise<void> {
    const policyDir = path.join(this.policyRootDir, orgId);
    await mkdir(policyDir, { recursive: true });

    const policy = {
      orgId,
      version: '1.0.0',
      rules: [
        {
          id: 'tenant-default-allow-read',
          effect: 'allow',
          actions: ['read:*'],
          principals: ['owner', 'admin', 'member', 'viewer'],
        },
        {
          id: 'tenant-default-manage',
          effect: 'allow',
          actions: ['write:*', 'manage:*'],
          principals: ['owner', 'admin'],
        },
      ],
    };

    await writeFile(path.join(policyDir, 'policy.json'), JSON.stringify(policy, null, 2), 'utf8');
  }
}
