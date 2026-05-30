import { HumanGateChannel, HumanGateNotificationClient } from './HumanGate';

export interface ActiveWorkflowRegistration {
  orgId: string;
  workflowId: string;
  terminate: () => Promise<void>;
}

export class KillSwitch {
  private readonly activeByOrg = new Map<string, Map<string, () => Promise<void>>>();
  private readonly killedOrgs = new Set<string>();

  constructor(
    private readonly notifier: HumanGateNotificationClient,
    private readonly notifyChannels: HumanGateChannel[] = ['webhook'],
  ) {}

  register(workflow: ActiveWorkflowRegistration): void {
    const orgMap = this.activeByOrg.get(workflow.orgId) ?? new Map<string, () => Promise<void>>();
    orgMap.set(workflow.workflowId, workflow.terminate);
    this.activeByOrg.set(workflow.orgId, orgMap);
  }

  unregister(orgId: string, workflowId: string): void {
    const orgMap = this.activeByOrg.get(orgId);
    if (!orgMap) return;
    orgMap.delete(workflowId);
    if (orgMap.size === 0) {
      this.activeByOrg.delete(orgId);
    }
  }

  isKilled(orgId: string): boolean {
    return this.killedOrgs.has(orgId);
  }

  clear(orgId: string): void {
    this.killedOrgs.delete(orgId);
  }

  async trigger(orgId: string, reason: string): Promise<{ terminatedWorkflowIds: string[] }> {
    this.killedOrgs.add(orgId);
    const orgMap = this.activeByOrg.get(orgId) ?? new Map<string, () => Promise<void>>();

    const terminatedWorkflowIds: string[] = [];
    await Promise.all(
      Array.from(orgMap.entries()).map(async ([workflowId, terminate]) => {
        await Promise.race([
          terminate(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Kill switch timeout for ${workflowId}`)), 5_000);
          }),
        ]);
        terminatedWorkflowIds.push(workflowId);
      }),
    );

    await Promise.all(
      this.notifyChannels.map((channel) =>
        this.notifier.send(channel, {
          requestId: `kill-switch-${orgId}`,
          orgId,
          workflowId: '*',
          stepId: 'kill-switch',
          channels: this.notifyChannels,
          createdAt: Date.now(),
          metadata: { reason, terminatedWorkflowIds },
        }),
      ),
    );

    return { terminatedWorkflowIds };
  }
}
