export type SandboxKind = 'docker' | 'wasm';

export interface SandboxCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SandboxResourceLimits {
  memoryMb?: number;
  nanoCpus?: number;
  pidsLimit?: number;
}

export interface SandboxMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface SandboxSpec {
  toolId: string;
  version: string;
  capabilityDir: string;
  command: SandboxCommand;
  mounts?: SandboxMount[];
  allowedEndpoints?: string[];
  labels?: Record<string, string>;
  image?: string;
  readOnlyRootFs?: boolean;
  resourceLimits?: SandboxResourceLimits;
}

export interface SandboxHandle {
  id: string;
  kind: SandboxKind;
  spec: SandboxSpec;
  startedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface SandboxHealth {
  healthy: boolean;
  detail?: string;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface IsolationStrategy {
  readonly kind: SandboxKind;
  isAvailable(): Promise<boolean>;
  provision(spec: SandboxSpec): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<SandboxHandle>;
  stop(handle: SandboxHandle): Promise<void>;
  remove(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxHealth>;
  execute(spec: SandboxSpec, command?: SandboxCommand): Promise<SandboxExecutionResult>;
}
