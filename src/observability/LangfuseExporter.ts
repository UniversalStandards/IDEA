import { Langfuse } from 'langfuse';
import { createLogger } from './logger';

const logger = createLogger('langfuse-exporter');

export interface LlmTraceEvent {
  orgId: string;
  traceId: string;
  userId?: string;
  model: string;
  input: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

interface LangfuseClient {
  trace(payload: Record<string, unknown>): { update(payload: Record<string, unknown>): void } | void;
  flushAsync?(): Promise<void>;
  shutdownAsync?(): Promise<void>;
}

export interface LangfuseExporterOptions {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushIntervalMs?: number;
}

export class LangfuseExporter {
  private readonly queue: LlmTraceEvent[] = [];
  private readonly flushIntervalMs: number;
  private readonly client: LangfuseClient;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: LangfuseExporterOptions, client?: LangfuseClient) {
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.client = client ?? (new Langfuse({
      publicKey: options.publicKey,
      secretKey: options.secretKey,
      baseUrl: options.baseUrl,
      enabled: true,
    }) as unknown as LangfuseClient);
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  exportCall(event: LlmTraceEvent): void {
    this.queue.push(event);
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);

    for (const entry of batch) {
      try {
        const trace = this.client.trace({
          id: entry.traceId,
          name: `${entry.orgId}:${entry.model}`,
          userId: entry.userId,
          sessionId: entry.orgId,
          metadata: {
            orgId: entry.orgId,
            requestId: entry.requestId,
            ...entry.metadata,
          },
          input: entry.input,
          output: entry.output,
          tags: [entry.orgId, entry.model],
        });

        trace?.update({
          output: entry.output,
          metadata: {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.inputTokens + entry.outputTokens,
            costUsd: entry.costUsd,
          },
        });
      } catch (err) {
        logger.warn('Langfuse trace export failed', {
          orgId: entry.orgId,
          traceId: entry.traceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.client.flushAsync?.();
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    await this.client.shutdownAsync?.();
  }
}
