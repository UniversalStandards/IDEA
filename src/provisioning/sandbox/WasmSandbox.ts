import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';
import { WASI } from 'wasi';
import { createLogger } from '../../observability/logger';
import type {
  IsolationStrategy,
  SandboxCommand,
  SandboxExecutionResult,
  SandboxHandle,
  SandboxHealth,
  SandboxSpec,
} from './Sandbox';

const logger = createLogger('wasm-sandbox');

interface ManagedProcess {
  handle: SandboxHandle;
  processId: number | undefined;
}

export class WasmSandbox implements IsolationStrategy {
  readonly kind = 'wasm' as const;
  private readonly running = new Map<string, ManagedProcess>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const handle: SandboxHandle = {
      id: `${spec.toolId}:${spec.version}:wasm`,
      kind: this.kind,
      spec,
      metadata: {
        capabilityDir: spec.capabilityDir,
      },
    };
    return handle;
  }

  async start(handle: SandboxHandle): Promise<SandboxHandle> {
    if (handle.spec.command.cmd.endsWith('.wasm')) {
      await this.executeWasiModule(handle.spec.command, handle.spec.capabilityDir);
      return { ...handle, startedAt: new Date() };
    }

    const child = spawn(handle.spec.command.cmd, handle.spec.command.args, {
      cwd: handle.spec.command.cwd ?? handle.spec.capabilityDir,
      env: this.buildEnv(handle.spec.command.env),
      stdio: 'ignore',
      detached: false,
    });

    this.running.set(handle.id, { handle, processId: child.pid });
    logger.info('Started lightweight fallback sandbox', {
      sandboxId: handle.id,
      pid: child.pid,
      toolId: handle.spec.toolId,
    });

    return {
      ...handle,
      startedAt: new Date(),
      metadata: {
        ...handle.metadata,
        pid: child.pid,
      },
    };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const managed = this.running.get(handle.id);
    if (managed?.processId) {
      process.kill(managed.processId, 'SIGTERM');
      this.running.delete(handle.id);
    }
  }

  async remove(handle: SandboxHandle): Promise<void> {
    this.running.delete(handle.id);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxHealth> {
    const managed = this.running.get(handle.id);
    return {
      healthy: managed !== undefined,
      detail: managed?.processId ? `pid:${managed.processId}` : 'not-running',
    };
  }

  async execute(spec: SandboxSpec, command?: SandboxCommand): Promise<SandboxExecutionResult> {
    const cmd = command ?? spec.command;
    if (cmd.cmd.endsWith('.wasm')) {
      const start = Date.now();
      await this.executeWasiModule(cmd, spec.capabilityDir);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - start,
      };
    }

    return new Promise<SandboxExecutionResult>((resolve, reject) => {
      const start = Date.now();
      const child = spawn(cmd.cmd, cmd.args, {
        cwd: cmd.cwd ?? spec.capabilityDir,
        env: this.buildEnv(cmd.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  private async executeWasiModule(command: SandboxCommand, capabilityDir: string): Promise<void> {
    const modulePath = path.resolve(capabilityDir, command.cmd);
    const wasmBytes = await readFile(modulePath);
    const wasi = new WASI({
      args: [modulePath, ...command.args],
      env: this.buildEnv(command.env),
      preopens: {
        '/workspace': capabilityDir,
      },
      version: 'preview1',
    });

    const wasmApi = (globalThis as typeof globalThis & {
      WebAssembly?: {
        compile(bytes: Buffer): Promise<unknown>;
        instantiate(module: unknown, imports: object): Promise<unknown>;
      };
    }).WebAssembly;
    if (!wasmApi) {
      throw new Error('WebAssembly runtime is unavailable in this Node.js environment');
    }

    const module = await wasmApi.compile(wasmBytes);
    const instance = await wasmApi.instantiate(module, wasi.getImportObject());
    wasi.start(instance as never);
    logger.info('Executed WASI module in fallback sandbox', { modulePath });
  }

  private buildEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
    return {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      ...(env ?? {}),
    };
  }
}
