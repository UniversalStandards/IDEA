import path from 'path';
import type { ToolMetadata } from '../discovery/types';
import type { DependencyResolver } from './dependency-resolver';
import type { SignatureVerifier, VerificationSummary } from './SignatureVerifier';
import type { SandboxSpec } from './sandbox/Sandbox';

export interface DryRunResult {
  success: boolean;
  toolId: string;
  version: string;
  dependencies: string[];
  verification: VerificationSummary;
  sandbox: SandboxSpec;
  installDir: string;
  steps: string[];
}

export class DryRunExecutor {
  private readonly verifier: SignatureVerifier;
  private readonly dependencyResolver: Pick<DependencyResolver, 'resolve'>;

  constructor(
    verifier: SignatureVerifier,
    dependencyResolver: Pick<DependencyResolver, 'resolve'>,
  ) {
    this.verifier = verifier;
    this.dependencyResolver = dependencyResolver;
  }

  async execute(tool: ToolMetadata, installRoot: string, sandboxSpec: SandboxSpec): Promise<DryRunResult> {
    const resolved = this.dependencyResolver.resolve(tool);
    const verification = await this.verifier.verifyTool(tool, resolved.installOrder);
    const installDir = path.resolve(installRoot, tool.id, tool.version);

    return {
      success: verification.verified,
      toolId: tool.id,
      version: tool.version,
      dependencies: resolved.installOrder,
      verification,
      sandbox: sandboxSpec,
      installDir,
      steps: [
        'policy-check',
        'trust-evaluation',
        'signature-verification',
        'version-pin',
        'sandbox-provision',
        'hot-reload-swap',
      ],
    };
  }
}
