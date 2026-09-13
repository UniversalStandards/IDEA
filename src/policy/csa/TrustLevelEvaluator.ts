import { z } from 'zod';
import { CsaTrustFramework, CsaTrustLevel } from './CsaTrustFramework';

export const TrustEvaluationInputSchema = z.object({
  role: z.string().min(1),
  permissions: z.array(z.string()).default([]),
  context: z.object({
    crossToolWorkflowCount: z.number().int().min(0).default(0),
    sensitiveActionApprovalRate: z.number().min(0).max(1).default(0),
    completedSecurityTraining: z.boolean().default(false),
    delegationAllowed: z.boolean().default(false),
    orgApprovalGranted: z.boolean().default(false),
  }),
  history: z.object({
    incidentsLast90Days: z.number().int().min(0).default(0),
    successfulRunsLast30Days: z.number().int().min(0).default(0),
  }),
});

export type TrustEvaluationInput = z.infer<typeof TrustEvaluationInputSchema>;

export interface TrustEvaluationResult {
  level: CsaTrustLevel;
  levelName: string;
  rationale: string[];
}

const ROLE_BASE_LEVEL: Record<string, CsaTrustLevel> = {
  intern: CsaTrustLevel.Intern,
  analyst: CsaTrustLevel.Assistant,
  operator: CsaTrustLevel.Assistant,
  developer: CsaTrustLevel.Collaborator,
  engineer: CsaTrustLevel.Collaborator,
  lead: CsaTrustLevel.Expert,
  architect: CsaTrustLevel.Expert,
  admin: CsaTrustLevel.Principal,
  principal: CsaTrustLevel.Principal,
};

export class TrustLevelEvaluator {
  constructor(private readonly framework: CsaTrustFramework = new CsaTrustFramework()) {}

  evaluate(input: TrustEvaluationInput): TrustEvaluationResult {
    const parsed = TrustEvaluationInputSchema.parse(input);
    const rationale: string[] = [];

    const roleKey = parsed.role.toLowerCase();
    let level = ROLE_BASE_LEVEL[roleKey] ?? CsaTrustLevel.Intern;
    rationale.push(`Base level from role '${parsed.role}' is ${this.framework.getLevelName(level)}`);

    if (parsed.permissions.includes('tool:execute:*')) {
      level = Math.max(level, CsaTrustLevel.Expert) as CsaTrustLevel;
      rationale.push('Elevated to Expert due to full tool execution permission');
    } else if (parsed.permissions.includes('tool:execute:approved')) {
      level = Math.max(level, CsaTrustLevel.Assistant) as CsaTrustLevel;
      rationale.push('Elevated to Assistant due to approved tool execution permission');
    }

    if (parsed.context.crossToolWorkflowCount > 0) {
      level = Math.max(level, CsaTrustLevel.Collaborator) as CsaTrustLevel;
      rationale.push('Elevated to Collaborator because cross-tool workflows were observed');
    }

    if (parsed.history.incidentsLast90Days > 0) {
      level = Math.min(level, CsaTrustLevel.Collaborator) as CsaTrustLevel;
      rationale.push('Capped at Collaborator due to recent incidents');
    }

    if (parsed.context.sensitiveActionApprovalRate < 0.9) {
      level = Math.min(level, CsaTrustLevel.Collaborator) as CsaTrustLevel;
      rationale.push('Capped at Collaborator due to insufficient sensitive action approval rate');
    }

    const canBePrincipal = this.framework.canTransition(CsaTrustLevel.Expert, CsaTrustLevel.Principal, {
      hasToolExecutionPermission: parsed.permissions.includes('tool:execute:*'),
      sensitiveOperationsApproved: parsed.context.sensitiveActionApprovalRate >= 0.95,
      completedSecurityTraining: parsed.context.completedSecurityTraining,
      orgApprovalGranted: parsed.context.orgApprovalGranted && parsed.context.delegationAllowed,
    });

    if (canBePrincipal && parsed.history.incidentsLast90Days === 0) {
      level = CsaTrustLevel.Principal;
      rationale.push('Elevated to Principal after passing CSA transition requirements');
    }

    return {
      level,
      levelName: this.framework.getLevelName(level),
      rationale,
    };
  }
}
