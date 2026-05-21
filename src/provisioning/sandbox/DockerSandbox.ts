import path from 'path';
import Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';
import { createLogger } from '../../observability/logger';
import type {
  IsolationStrategy,
  SandboxCommand,
  SandboxExecutionResult,
  SandboxHandle,
  SandboxHealth,
  SandboxSpec,
} from './Sandbox';

const logger = createLogger('docker-sandbox');

interface DockerSandboxOptions {
  docker?: Docker;
  socketPath?: string;
  defaultImage?: string;
  pullIfMissing?: boolean;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function buildEnv(env: Record<string, string> | undefined, allowedEndpoints: string[]): string[] {
  const entries = Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
  if (allowedEndpoints.length > 0) {
    entries.push(`ALLOWED_ENDPOINTS=${allowedEndpoints.join(',')}`);
  }
  return entries;
}

function buildHostConfig(spec: SandboxSpec): NonNullable<ContainerCreateOptions['HostConfig']> {
  const binds = [
    `${path.resolve(spec.capabilityDir)}:/workspace:rw`,
    ...((spec.mounts ?? []).map((mount) =>
      `${path.resolve(mount.source)}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}`,
    )),
  ];

  return {
    AutoRemove: false,
    Binds: binds,
    CapDrop: ['ALL'],
    NetworkMode: (spec.allowedEndpoints?.length ?? 0) > 0 ? 'bridge' : 'none',
    ReadonlyRootfs: spec.readOnlyRootFs ?? true,
    SecurityOpt: ['no-new-privileges:true'],
    Tmpfs: {
      '/tmp': 'rw,noexec,nosuid,nodev,size=64m',
      '/run': 'rw,noexec,nosuid,nodev,size=16m',
    },
    Memory: (spec.resourceLimits?.memoryMb ?? 512) * 1024 * 1024,
    NanoCpus: spec.resourceLimits?.nanoCpus ?? 1_000_000_000,
    PidsLimit: spec.resourceLimits?.pidsLimit ?? 128,
  };
}

export class DockerSandbox implements IsolationStrategy {
  readonly kind = 'docker' as const;
  private readonly docker: Docker;
  private readonly defaultImage: string;
  private readonly pullIfMissing: boolean;

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = options.docker ?? new Docker({ socketPath: options.socketPath ?? '/var/run/docker.sock' });
    this.defaultImage = options.defaultImage ?? 'node:20-alpine';
    this.pullIfMissing = options.pullIfMissing ?? true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (error) {
      logger.warn('Docker unavailable for sandboxing', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    await this.ensureImage(spec.image ?? this.defaultImage);

    const container = await this.docker.createContainer(this.buildContainerOptions(spec));
    logger.info('Provisioned docker sandbox', { toolId: spec.toolId, containerId: container.id });

    return {
      id: container.id,
      kind: this.kind,
      spec,
      metadata: {
        image: spec.image ?? this.defaultImage,
        containerName: this.containerName(spec),
      },
    };
  }

  async start(handle: SandboxHandle): Promise<SandboxHandle> {
    const container = this.docker.getContainer(handle.id);
    await container.start();
    logger.info('Started docker sandbox', { sandboxId: handle.id, toolId: handle.spec.toolId });
    return { ...handle, startedAt: new Date() };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const container = this.docker.getContainer(handle.id);
    try {
      await container.stop({ t: 10 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('is not running')) {
        throw error;
      }
    }
    logger.info('Stopped docker sandbox', { sandboxId: handle.id, toolId: handle.spec.toolId });
  }

  async remove(handle: SandboxHandle): Promise<void> {
    const container = this.docker.getContainer(handle.id);
    try {
      await container.remove({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('No such container')) {
        throw error;
      }
    }
    logger.info('Removed docker sandbox', { sandboxId: handle.id, toolId: handle.spec.toolId });
  }

  async inspect(handle: SandboxHandle): Promise<SandboxHealth> {
    try {
      const details = await this.docker.getContainer(handle.id).inspect();
      return {
        healthy: Boolean(details.State?.Running),
        detail: details.State?.Status,
      };
    } catch (error) {
      return {
        healthy: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(spec: SandboxSpec, command?: SandboxCommand): Promise<SandboxExecutionResult> {
    await this.ensureImage(spec.image ?? this.defaultImage);

    const start = Date.now();
    const cmd = command ?? spec.command;
    const container = await this.docker.createContainer(
      this.buildContainerOptions(spec, cmd, true),
    );

    try {
      await container.start();
      const waitResult = await container.wait();
      const logs = await container.logs({ stdout: true, stderr: true, follow: false });
      const output = Buffer.isBuffer(logs) ? logs.toString('utf8') : String(logs);

      return {
        exitCode: typeof waitResult.StatusCode === 'number' ? waitResult.StatusCode : 1,
        stdout: output,
        stderr: output,
        durationMs: Date.now() - start,
      };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private buildContainerOptions(
    spec: SandboxSpec,
    command = spec.command,
    autoRemove = false,
  ): ContainerCreateOptions {
    const image = spec.image ?? this.defaultImage;

    return {
      name: this.containerName(spec),
      Image: image,
      Cmd: [command.cmd, ...command.args],
      Env: buildEnv(command.env, spec.allowedEndpoints ?? []),
      WorkingDir: command.cwd ?? '/workspace',
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      User: '1001:1001',
      Labels: {
        'idea.sandbox': 'true',
        'idea.tool_id': spec.toolId,
        'idea.tool_version': spec.version,
        ...spec.labels,
      },
      HostConfig: {
        ...buildHostConfig(spec),
        AutoRemove: autoRemove,
      },
    };
  }

  private containerName(spec: SandboxSpec): string {
    return `idea-${sanitizeName(spec.toolId)}-${sanitizeName(spec.version)}`;
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      if (!this.pullIfMissing) {
        throw new Error(`Docker image not present: ${image}`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (error: Error | null, stream: NodeJS.ReadableStream | undefined) => {
        if (error) {
          reject(error);
          return;
        }
        if (!stream) {
          reject(new Error(`Failed to pull image ${image}`));
          return;
        }
        this.docker.modem.followProgress(stream, (progressError: Error | null) => {
          if (progressError) {
            reject(progressError);
            return;
          }
          resolve();
        });
      });
    });

    logger.info('Pulled docker image for sandbox', { image });
  }
}
