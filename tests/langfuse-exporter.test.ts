import { LangfuseExporter, type LlmTraceEvent } from '../src/observability/LangfuseExporter';

describe('LangfuseExporter', () => {
  it('batches traces and flushes asynchronously', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const traces: Array<Record<string, unknown>> = [];
    const client = {
      trace: (payload: Record<string, unknown>) => {
        traces.push(payload);
        return {
          update: (updatePayload: Record<string, unknown>) => {
            updates.push(updatePayload);
          },
        };
      },
      flushAsync: jest.fn(async () => Promise.resolve()),
      shutdownAsync: jest.fn(async () => Promise.resolve()),
    };

    const exporter = new LangfuseExporter(
      { publicKey: 'pk', secretKey: 'sk', flushIntervalMs: 1_000_000 },
      client,
    );

    const event: LlmTraceEvent = {
      orgId: 'org-1',
      traceId: 'trace-1',
      model: 'gpt-4o',
      input: 'hello',
      output: 'world',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    };
    exporter.exportCall(event);
    expect(exporter.getPendingCount()).toBe(1);

    await exporter.flush();
    expect(traces).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(client.flushAsync).toHaveBeenCalledTimes(1);

    await exporter.shutdown();
    expect(client.shutdownAsync).toHaveBeenCalledTimes(1);
  });
});
