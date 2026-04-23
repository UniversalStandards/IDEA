import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export class Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly name: string;
  readonly startTime: number;
  readonly parentSpanId?: string;
  endTime?: number;
  status: SpanStatus = 'unset';
  attributes: SpanAttributes = {};

  constructor(name: string, traceId: string, parentSpanId?: string) {
    this.spanId = randomUUID();
    this.traceId = traceId;
    this.name = name;
    this.startTime = Date.now();
    if (parentSpanId !== undefined) {
      this.parentSpanId = parentSpanId;
    }
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  finish(status: SpanStatus = 'ok'): void {
    this.endTime = Date.now();
    this.status = status;
  }

  get durationMs(): number | undefined {
    if (this.endTime === undefined) return undefined;
    return this.endTime - this.startTime;
  }

  toJSON(): object {
    return {
      spanId: this.spanId,
      traceId: this.traceId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      status: this.status,
      attributes: this.attributes,
    };
  }
}

interface TracingContext {
  span: Span;
}

export class Tracer {
  private readonly storage = new AsyncLocalStorage<TracingContext>();
  private readonly completedSpans: Span[] = [];
  private readonly maxCompletedSpans = 10_000;

  startSpan(name: string, parentSpanId?: string): Span {
    const activeSpan = this.getActiveSpan();
    const traceId = activeSpan?.traceId ?? randomUUID();
    const resolvedParentId = parentSpanId ?? activeSpan?.spanId;
    return new Span(name, traceId, resolvedParentId);
  }

  getActiveSpan(): Span | undefined {
    return this.storage.getStore()?.span;
  }

  async withSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    return this.storage.run({ span }, async () => {
      try {
        const result = await fn();
        if (span.status === 'unset') span.finish('ok');
        return result;
      } catch (err) {
        span.finish('error');
        throw err;
      } finally {
        this.recordSpan(span);
      }
    });
  }

  withSpanSync<T>(span: Span, fn: () => T): T {
    return this.storage.run({ span }, () => {
      try {
        const result = fn();
        if (span.status === 'unset') span.finish('ok');
        return result;
      } catch (err) {
        span.finish('error');
        throw err;
      } finally {
        this.recordSpan(span);
      }
    });
  }

  /**
   * Runs fn inside the span's async context WITHOUT auto-finishing the span.
   * Use this when the span lifetime outlives the synchronous call (e.g. HTTP
   * request middleware), and you will call `span.finish()` + `recordSpan()`
   * manually at the appropriate time.
   */
  runWithContext<T>(span: Span, fn: () => T): T {
    return this.storage.run({ span }, fn);
  }

  recordSpan(span: Span): void {
    if (this.completedSpans.length >= this.maxCompletedSpans) {
      this.completedSpans.shift();
    }
    this.completedSpans.push(span);
  }

  getCompletedSpans(): Readonly<Span[]> {
    return this.completedSpans;
  }

  clearCompletedSpans(): void {
    this.completedSpans.length = 0;
  }
}

export const tracer = new Tracer();

/**
 * Returns the traceId and spanId of the currently active span, if any.
 * Useful for including trace context in structured log entries.
 */
export function getTraceFields(): { traceId?: string; spanId?: string } {
  const span = tracer.getActiveSpan();
  if (!span) return {};
  return { traceId: span.traceId, spanId: span.spanId };
}
