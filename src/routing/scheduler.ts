import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { config } from '../config';
import { getRedis } from '../core/redis-client';

const logger = createLogger('scheduler');

// Redis key for distributed queue depth (shared across all hub instances)
const REDIS_QUEUE_DEPTH_KEY = 'scheduler:queue_depth';
const REDIS_RUNNING_KEY = 'scheduler:running';

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
      const queueDepth = this.queue.length;
      metrics.gauge('scheduler_queue_depth', queueDepth);
      logger.debug('Task scheduled', { taskId: task.id, priority, queueDepth });

      // Propagate local queue depth to Redis for distributed observability.
      // Fire-and-forget — a Redis failure must never block task scheduling.
      this.syncQueueDepthToRedis(queueDepth);

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
      this.syncRunningToRedis(this.running);

      const start = Date.now();
      task
        .fn()
        .then((result) => {
          this.completed++;
          this.running--;
          metrics.increment('scheduler_completed_total');
          metrics.histogram('scheduler_task_duration_ms', Date.now() - start);
          metrics.gauge('scheduler_running', this.running);
          this.syncRunningToRedis(this.running);
          logger.debug('Task completed', { taskId: task.id, durationMs: Date.now() - start });
          task.resolve(result);
          this.drain();
        })
        .catch((err: unknown) => {
          this.failed++;
          this.running--;
          metrics.increment('scheduler_failed_total');
          metrics.gauge('scheduler_running', this.running);
          this.syncRunningToRedis(this.running);
          logger.warn('Task failed', {
            taskId: task.id,
            err: err instanceof Error ? err.message : String(err),
          });
          task.reject(err);
          this.drain();
        });
    }

    // Keep distributed queue-depth in sync as tasks are drained
    this.syncQueueDepthToRedis(this.queue.length);
  }

  /**
   * Write this instance's queue depth into Redis so external observers
   * (dashboards, other hub nodes) can see aggregate load.
   * Uses SETEX with a short TTL so stale data self-expires.
   */
  private syncQueueDepthToRedis(depth: number): void {
    const redis = getRedis();
    if (!redis) return;
    redis.setex(REDIS_QUEUE_DEPTH_KEY, 60, String(depth)).catch((err: Error) => {
      logger.debug('Redis queue depth sync failed', { err: err.message });
    });
  }

  private syncRunningToRedis(count: number): void {
    const redis = getRedis();
    if (!redis) return;
    redis.setex(REDIS_RUNNING_KEY, 60, String(count)).catch((err: Error) => {
      logger.debug('Redis running count sync failed', { err: err.message });
    });
  }

  getStats(): SchedulerStats {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
    };
  }

  /**
   * Returns scheduler stats enriched with distributed counts from Redis.
   * Falls back to local stats when Redis is unavailable.
   */
  async getDistributedStats(): Promise<SchedulerStats & { distributed: boolean }> {
    const redis = getRedis();
    if (!redis) {
      return { ...this.getStats(), distributed: false };
    }

    try {
      const [queuedRaw, runningRaw] = await redis.mget(
        REDIS_QUEUE_DEPTH_KEY,
        REDIS_RUNNING_KEY,
      );
      return {
        queued: queuedRaw != null ? parseInt(queuedRaw, 10) : this.queue.length,
        running: runningRaw != null ? parseInt(runningRaw, 10) : this.running,
        completed: this.completed,
        failed: this.failed,
        distributed: true,
      };
    } catch (err) {
      logger.warn('Redis distributed stats read failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return { ...this.getStats(), distributed: false };
    }
  }
}

export const scheduler = new Scheduler();
