import { EventEmitter } from 'events';
import { createLogger } from '../observability/logger';
import type { ToolMetadata } from '../discovery/types';
import type { ToolRuntimeConfig } from './config-generator';
import type { RuntimeRegistrar } from './runtime-registrar';
import type { IsolationStrategy, SandboxHandle } from './sandbox/Sandbox';

const logger = createLogger('hot-reloader');

export interface HotReloadRequest {
  tool: ToolMetadata;
  config: ToolRuntimeConfig;
  sandbox: IsolationStrategy;
  nextHandle: SandboxHandle;
  previousHandle?: SandboxHandle;
  drainTimeoutMs?: number;
}

export interface HotReloadResult {
  activeHandle: SandboxHandle;
  previousHandle?: SandboxHandle;
  swappedAt: Date;
}

export class HotReloader extends EventEmitter {
  private readonly runtimeRegistrar: Pick<RuntimeRegistrar, 'register'>;
  private readonly activeSandboxes = new Map<string, SandboxHandle>();

  constructor(runtimeRegistrar: Pick<RuntimeRegistrar, 'register'>) {
    super();
    this.runtimeRegistrar = runtimeRegistrar;
  }

  async reload(request: HotReloadRequest): Promise<HotReloadResult> {
    const drainTimeoutMs = request.drainTimeoutMs ?? 5_000;
    this.emit('swap:starting', { toolId: request.tool.id, version: request.tool.version });

    const startedHandle = await request.sandbox.start(request.nextHandle);
    this.runtimeRegistrar.register(request.tool, request.config);
    const previousHandle = request.previousHandle ?? this.activeSandboxes.get(request.tool.id);
    this.activeSandboxes.set(request.tool.id, startedHandle);

    if (previousHandle) {
      await this.drainAndStop(request.sandbox, previousHandle, drainTimeoutMs);
    }

    const result: HotReloadResult = previousHandle
      ? { activeHandle: startedHandle, previousHandle, swappedAt: new Date() }
      : { activeHandle: startedHandle, swappedAt: new Date() };

    this.emit('swap:complete', { toolId: request.tool.id, version: request.tool.version });
    logger.info('Hot reload swap complete', {
      toolId: request.tool.id,
      version: request.tool.version,
      replacedSandboxId: previousHandle?.id,
      activeSandboxId: startedHandle.id,
    });

    return result;
  }

  getActiveHandle(toolId: string): SandboxHandle | undefined {
    return this.activeSandboxes.get(toolId);
  }

  setActiveHandle(toolId: string, handle: SandboxHandle): void {
    this.activeSandboxes.set(toolId, handle);
  }

  clearActiveHandle(toolId: string): void {
    this.activeSandboxes.delete(toolId);
  }

  private async drainAndStop(
    sandbox: IsolationStrategy,
    handle: SandboxHandle,
    drainTimeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, drainTimeoutMs);
      timer.unref();
    });
    await sandbox.stop(handle);
    await sandbox.remove(handle);
  }
}
