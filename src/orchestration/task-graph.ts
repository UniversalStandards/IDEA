import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const logger = createLogger('task-graph');

export interface Task {
  id: string;
  name: string;
  dependencies: string[];
  fn: (inputs: Record<string, unknown>) => Promise<unknown>;
  timeout?: number;
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

const DEFAULT_TIMEOUT_MS = 30_000;

export class TaskGraph {
  private readonly tasks = new Map<string, Task>();
  private readonly status = new Map<string, TaskStatus>();
  private readonly results = new Map<string, unknown>();

  addTask(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    this.tasks.set(task.id, task);
    this.status.set(task.id, 'pending');
    logger.debug('Task added to graph', { taskId: task.id, deps: task.dependencies });
  }

  async execute(): Promise<Record<string, unknown>> {
    this.validateNoCycles();
    await this.runAll();
    const output: Record<string, unknown> = {};
    for (const [id, result] of this.results) {
      output[id] = result;
    }
    return output;
  }

  getStatus(): Record<string, TaskStatus> {
    const out: Record<string, TaskStatus> = {};
    for (const [id, s] of this.status) {
      out[id] = s;
    }
    return out;
  }

  private validateNoCycles(): void {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string): void => {
      if (stack.has(id)) {
        throw new Error(`Circular dependency detected involving task: ${id}`);
      }
      if (visited.has(id)) return;
      visited.add(id);
      stack.add(id);

      const task = this.tasks.get(id);
      if (!task) throw new Error(`Unknown task referenced: ${id}`);

      for (const dep of task.dependencies) {
        dfs(dep);
      }
      stack.delete(id);
    };

    for (const id of this.tasks.keys()) {
      dfs(id);
    }
  }

  private async runAll(): Promise<void> {
    const pending = new Set(this.tasks.keys());
    const inFlight = new Set<string>();

    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (pending.size === 0 && inFlight.size === 0) {
          resolve();
          return;
        }

        // Find tasks whose dependencies are all completed (not failed)
        for (const id of [...pending]) {
          const task = this.tasks.get(id)!;

          // Check if any dep failed — propagate failure
          const failedDep = task.dependencies.find(
            (d) => this.status.get(d) === 'failed',
          );
          if (failedDep) {
            this.status.set(id, 'failed');
            this.results.set(id, new Error(`Dependency ${failedDep} failed`));
            pending.delete(id);
            metrics.increment('task_graph_skipped_total', { taskId: id });
            logger.warn('Task skipped due to failed dependency', { taskId: id, failedDep });
            tick();
            return;
          }

          const allDepsComplete = task.dependencies.every(
            (d) => this.status.get(d) === 'completed',
          );
          if (!allDepsComplete) continue;

          pending.delete(id);
          inFlight.add(id);
          this.status.set(id, 'running');

          const inputs: Record<string, unknown> = {};
          for (const dep of task.dependencies) {
            inputs[dep] = this.results.get(dep);
          }

          const timeoutMs = task.timeout ?? DEFAULT_TIMEOUT_MS;
          const taskPromise = this.runWithTimeout(task, inputs, timeoutMs);

          taskPromise
            .then((result) => {
              this.status.set(id, 'completed');
              this.results.set(id, result);
              inFlight.delete(id);
              metrics.increment('task_graph_completed_total', { taskId: id });
              logger.debug('Task completed', { taskId: id });
              tick();
            })
            .catch((err: unknown) => {
              this.status.set(id, 'failed');
              this.results.set(id, err);
              inFlight.delete(id);
              metrics.increment('task_graph_failed_total', { taskId: id });
              logger.warn('Task failed', {
                taskId: id,
                err: err instanceof Error ? err.message : String(err),
              });
              tick();
            });
        }

        // If nothing can make progress but items are still pending
        if (inFlight.size === 0 && pending.size > 0) {
          // All remaining tasks have deps that failed — mark them failed
          for (const id of [...pending]) {
            this.status.set(id, 'failed');
            this.results.set(id, new Error('Dependency chain failure'));
            pending.delete(id);
          }
          reject(new Error('Task graph execution stalled — dependency chain failures'));
        }
      };

      tick();
    });
  }

  private runWithTimeout(
    task: Task,
    inputs: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task ${task.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      task
        .fn(inputs)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
