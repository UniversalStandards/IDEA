import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';

const logger = createLogger('scheduler');

export interface ScheduledTask {
  id: string;
  priority: number;
  createdAt: Date;
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface SchedulerStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export class Scheduler {
  private readonly queue: ScheduledTask[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private readonly maxConcurrency: number;

  constructor(maxConcurrency?: number) {
    this.maxConcurrency = maxConcurrency ?? config.MAX_CONCURRENT_INSTALLS;
  }

  schedule<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: ScheduledTask = {
        id: randomUUID(),
        priority,
        createdAt: new Date(),
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      this.enqueue(task);
      metrics.gauge('scheduler_queue_depth', this.queue.length);
      logger.debug('Task scheduled', { taskId: task.id, priority, queueDepth: this.queue.length });

      this.drain();
    });
  }

  private enqueue(task: ScheduledTask): void {
    // Binary insert to keep queue sorted descending by priority
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.queue[mid]?.priority ?? 0) >= task.priority) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, task);
  }

  private drain(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.running++;
      metrics.gauge('scheduler_running', this.running);

      const start = Date.now();
      task
        .fn()
        .then((result) => {
          this.completed++;
          this.running--;
          metrics.increment('scheduler_completed_total');
          metrics.histogram('scheduler_task_duration_ms', Date.now() - start);
          metrics.gauge('scheduler_running', this.running);
          logger.debug('Task completed', { taskId: task.id, durationMs: Date.now() - start });
          task.resolve(result);
          this.drain();
        })
        .catch((err: unknown) => {
          this.failed++;
          this.running--;
          metrics.increment('scheduler_failed_total');
          metrics.gauge('scheduler_running', this.running);
          logger.warn('Task failed', {
            taskId: task.id,
            err: err instanceof Error ? err.message : String(err),
          });
          task.reject(err);
          this.drain();
        });
    }
  }

  getStats(): SchedulerStats {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
    };
  }
}

export const scheduler = new Scheduler();
