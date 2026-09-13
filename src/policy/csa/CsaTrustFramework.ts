import { z } from 'zod';

export enum CsaTrustLevel {
  Intern = 1,
  Assistant = 2,
  Collaborator = 3,
  Expert = 4,
  Principal = 5,
}

export interface TrustTransitionContext {
  hasToolExecutionPermission: boolean;
  sensitiveOperationsApproved: boolean;
  completedSecurityTraining: boolean;
  orgApprovalGranted: boolean;
}

export const CsaTrustLevelSchema = z.nativeEnum(CsaTrustLevel);

const levelNames: Record<CsaTrustLevel, string> = {
  [CsaTrustLevel.Intern]: 'Intern',
  [CsaTrustLevel.Assistant]: 'Assistant',
  [CsaTrustLevel.Collaborator]: 'Collaborator',
  [CsaTrustLevel.Expert]: 'Expert',
  [CsaTrustLevel.Principal]: 'Principal',
};

const levelPermissions: Record<CsaTrustLevel, string[]> = {
  [CsaTrustLevel.Intern]: ['read:*'],
  [CsaTrustLevel.Assistant]: ['read:*', 'tool:execute:approved'],
  [CsaTrustLevel.Collaborator]: ['read:*', 'tool:execute:approved', 'workflow:cross-tool', 'approval:required:sensitive'],
  [CsaTrustLevel.Expert]: ['read:*', 'tool:execute:*', 'workflow:cross-tool', 'plan:self-directed'],
  [CsaTrustLevel.Principal]: ['read:*', 'tool:execute:*', 'workflow:cross-domain', 'delegate:agent', 'authority:org-wide'],
};

export class CsaTrustFramework {
  getLevelName(level: CsaTrustLevel): string {
    return levelNames[level];
  }

  getPermissions(level: CsaTrustLevel): string[] {
    return [...levelPermissions[level]];
  }

  canTransition(from: CsaTrustLevel, to: CsaTrustLevel, context: TrustTransitionContext): boolean {
    CsaTrustLevelSchema.parse(from);
    CsaTrustLevelSchema.parse(to);

    if (to === from) {
      return true;
    }

    // Downgrades are always allowed.
    if (to < from) {
      return true;
    }

    // Upgrades can only move one level at a time to prevent leapfrogging controls.
    if (to - from > 1) {
      return false;
    }

    switch (to) {
      case CsaTrustLevel.Assistant:
        return context.hasToolExecutionPermission;
      case CsaTrustLevel.Collaborator:
        return context.hasToolExecutionPermission && context.sensitiveOperationsApproved;
      case CsaTrustLevel.Expert:
        return context.hasToolExecutionPermission && context.sensitiveOperationsApproved && context.completedSecurityTraining;
      case CsaTrustLevel.Principal:
        return (
          context.hasToolExecutionPermission &&
          context.sensitiveOperationsApproved &&
          context.completedSecurityTraining &&
          context.orgApprovalGranted
        );
      default:
        return false;
    }
  }

  enforceMinimumLevel(currentLevel: CsaTrustLevel, requiredLevel: CsaTrustLevel): boolean {
    return currentLevel >= requiredLevel;
  }
}
