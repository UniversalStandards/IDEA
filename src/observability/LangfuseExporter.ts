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
  private client: LangfuseClient | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly options: LangfuseExporterOptions;

  constructor(options: LangfuseExporterOptions, client?: LangfuseClient) {
    this.options = options;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.client = client;
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
    const client = await this.getClient();
    const batch = this.queue.splice(0, this.queue.length);

    for (const entry of batch) {
      try {
        const trace = client.trace({
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

    await client.flushAsync?.();
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    await this.client?.shutdownAsync?.();
  }

  private async getClient(): Promise<LangfuseClient> {
    if (this.client) {
      return this.client;
    }

    const { Langfuse } = await import('langfuse');
    const langfuseOptions: {
      publicKey: string;
      secretKey: string;
      enabled: true;
      baseUrl?: string;
    } = {
      publicKey: this.options.publicKey,
      secretKey: this.options.secretKey,
      enabled: true,
    };
    if (this.options.baseUrl !== undefined) {
      langfuseOptions.baseUrl = this.options.baseUrl;
    }
    this.client = new Langfuse(langfuseOptions) as unknown as LangfuseClient;
    return this.client;
  }
}
