/**
 * Tests for src/observability/tracing.ts
 */
import { Span, Tracer, tracer, getTraceFields } from '../src/observability/tracing';

describe('Span', () => {
  it('initializes with expected defaults', () => {
    const span = new Span('test.op', 'trace-1');
    expect(span.name).toBe('test.op');
    expect(span.traceId).toBe('trace-1');
    expect(span.parentSpanId).toBeUndefined();
    expect(span.status).toBe('unset');
    expect(span.endTime).toBeUndefined();
    expect(span.durationMs).toBeUndefined();
    expect(typeof span.spanId).toBe('string');
    expect(span.spanId).toHaveLength(36); // UUID v4
  });

  it('accepts a parentSpanId', () => {
    const span = new Span('child', 'trace-1', 'parent-span-id');
    expect(span.parentSpanId).toBe('parent-span-id');
  });

  it('setAttribute stores the value and returns this', () => {
    const span = new Span('op', 'trace-1');
    const result = span.setAttribute('http.method', 'GET');
    expect(result).toBe(span);
    expect(span.attributes['http.method']).toBe('GET');
  });

  it('setAttributes merges multiple values', () => {
    const span = new Span('op', 'trace-1');
    span.setAttributes({ a: 1, b: 'two', c: true });
    expect(span.attributes).toMatchObject({ a: 1, b: 'two', c: true });
  });

  it('finish sets endTime and status', () => {
    const span = new Span('op', 'trace-1');
    span.finish('ok');
    expect(span.endTime).toBeDefined();
    expect(span.status).toBe('ok');
    expect(typeof span.durationMs).toBe('number');
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('finish defaults to ok', () => {
    const span = new Span('op', 'trace-1');
    span.finish();
    expect(span.status).toBe('ok');
  });

  it('finish with error sets error status', () => {
    const span = new Span('op', 'trace-1');
    span.finish('error');
    expect(span.status).toBe('error');
  });

  it('toJSON returns expected shape', () => {
    const span = new Span('op', 'trace-abc', 'parent-id');
    span.setAttribute('k', 'v');
    span.finish('ok');
    const json = span.toJSON() as Record<string, unknown>;
    expect(json['spanId']).toBe(span.spanId);
    expect(json['traceId']).toBe('trace-abc');
    expect(json['parentSpanId']).toBe('parent-id');
    expect(json['name']).toBe('op');
    expect(json['status']).toBe('ok');
    expect(json['attributes']).toMatchObject({ k: 'v' });
  });
});

describe('Tracer', () => {
  let t: Tracer;

  beforeEach(() => {
    t = new Tracer();
  });

  describe('startSpan', () => {
    it('creates a span with a new traceId when no active span exists', () => {
      const span = t.startSpan('my.op');
      expect(span.traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(span.parentSpanId).toBeUndefined();
    });

    it('inherits traceId and parentSpanId from the active span', async () => {
      const parent = t.startSpan('parent.op');
      let child: Span | undefined;
      await t.withSpan(parent, async () => {
        child = t.startSpan('child.op');
      });
      expect(child).toBeDefined();
      expect(child!.traceId).toBe(parent.traceId);
      expect(child!.parentSpanId).toBe(parent.spanId);
    });

    it('accepts an explicit parentSpanId override', () => {
      const span = t.startSpan('op', 'explicit-parent');
      expect(span.parentSpanId).toBe('explicit-parent');
    });
  });

  describe('getActiveSpan', () => {
    it('returns undefined outside any span context', () => {
      expect(t.getActiveSpan()).toBeUndefined();
    });

    it('returns the current span inside withSpan', async () => {
      const span = t.startSpan('active.test');
      let seen: Span | undefined;
      await t.withSpan(span, async () => {
        seen = t.getActiveSpan();
      });
      expect(seen).toBe(span);
    });

    it('returns the current span inside withSpanSync', () => {
      const span = t.startSpan('sync.test');
      let seen: Span | undefined;
      t.withSpanSync(span, () => {
        seen = t.getActiveSpan();
      });
      expect(seen).toBe(span);
    });
  });

  describe('withSpan', () => {
    it('auto-finishes the span with ok on success', async () => {
      const span = t.startSpan('auto-ok');
      await t.withSpan(span, async () => 'result');
      expect(span.status).toBe('ok');
      expect(span.endTime).toBeDefined();
    });

    it('auto-finishes the span with error on throw', async () => {
      const span = t.startSpan('auto-err');
      await expect(
        t.withSpan(span, async () => { throw new Error('oops'); }),
      ).rejects.toThrow('oops');
      expect(span.status).toBe('error');
    });

    it('records the span in completedSpans', async () => {
      const span = t.startSpan('recorded');
      await t.withSpan(span, async () => undefined);
      expect(t.getCompletedSpans()).toContain(span);
    });

    it('returns the value from the callback', async () => {
      const span = t.startSpan('return-val');
      const result = await t.withSpan(span, async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('withSpanSync', () => {
    it('auto-finishes the span with ok on success', () => {
      const span = t.startSpan('sync-ok');
      t.withSpanSync(span, () => 'done');
      expect(span.status).toBe('ok');
    });

    it('auto-finishes the span with error on throw', () => {
      const span = t.startSpan('sync-err');
      expect(() => t.withSpanSync(span, () => { throw new Error('sync-fail'); })).toThrow('sync-fail');
      expect(span.status).toBe('error');
    });

    it('records the span in completedSpans', () => {
      const span = t.startSpan('sync-recorded');
      t.withSpanSync(span, () => undefined);
      expect(t.getCompletedSpans()).toContain(span);
    });
  });

  describe('runWithContext', () => {
    it('makes the span accessible via getActiveSpan', () => {
      const span = t.startSpan('ctx-span');
      let seen: Span | undefined;
      t.runWithContext(span, () => {
        seen = t.getActiveSpan();
      });
      expect(seen).toBe(span);
    });

    it('does NOT auto-finish the span', () => {
      const span = t.startSpan('no-auto-finish');
      t.runWithContext(span, () => undefined);
      expect(span.endTime).toBeUndefined();
    });

    it('does NOT add span to completedSpans automatically', () => {
      const span = t.startSpan('no-auto-record');
      t.runWithContext(span, () => undefined);
      expect(t.getCompletedSpans()).not.toContain(span);
    });

    it('allows manual finish + recordSpan', () => {
      const span = t.startSpan('manual-record');
      t.runWithContext(span, () => undefined);
      span.finish('ok');
      t.recordSpan(span);
      expect(t.getCompletedSpans()).toContain(span);
    });
  });

  describe('completedSpans management', () => {
    it('clearCompletedSpans empties the list', async () => {
      const span = t.startSpan('c1');
      await t.withSpan(span, async () => undefined);
      expect(t.getCompletedSpans().length).toBeGreaterThan(0);
      t.clearCompletedSpans();
      expect(t.getCompletedSpans().length).toBe(0);
    });
  });
});

describe('getTraceFields', () => {
  it('returns empty object when no active span', () => {
    // The module-level tracer has no active span in this test context
    const fields = getTraceFields();
    expect(fields).toEqual({});
  });

  it('returns traceId and spanId inside an active span', async () => {
    const span = tracer.startSpan('trace-fields-test');
    let fields: { traceId?: string; spanId?: string } = {};
    await tracer.withSpan(span, async () => {
      fields = getTraceFields();
    });
    expect(fields.traceId).toBe(span.traceId);
    expect(fields.spanId).toBe(span.spanId);
  });
});
