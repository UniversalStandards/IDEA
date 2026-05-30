import { createHmac } from 'crypto';
import { createLogger } from '../../observability/logger';
import {
  type WebhookEventType,
  type WebhookRecord,
  type WebhookStore,
} from './WebhookStore';

const logger = createLogger('webhook-delivery');

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export interface WebhookDeliveryOptions {
  readonly store: WebhookStore;
  readonly retryDelaysMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly wait?: (ms: number) => Promise<void>;
}

export class WebhookDelivery {
  private readonly retryDelaysMs: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: WebhookDeliveryOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wait =
      options.wait ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async deliverToOrg(
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await this.options.store.listByEvent(orgId, eventType);
    await Promise.all(hooks.map((hook) => this.deliverToWebhook(hook, eventType, payload)));
  }

  private async deliverToWebhook(
    webhook: WebhookRecord,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      eventType,
      orgId: webhook.orgId,
      timestamp: new Date().toISOString(),
      payload,
    });

    const attemptsTotal = this.retryDelaysMs.length + 1;
    let lastError = 'unknown delivery error';

    for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
      try {
        await this.send(webhook, body);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < attemptsTotal) {
          const delay = this.retryDelaysMs[attempt - 1] ?? 0;
          await this.wait(delay);
          continue;
        }
      }
    }

    logger.error('Webhook delivery failed after retries', {
      webhookId: webhook.id,
      orgId: webhook.orgId,
      eventType,
      attempts: attemptsTotal,
      error: lastError,
    });

    await this.options.store.recordDeadLetter({
      webhookId: webhook.id,
      orgId: webhook.orgId,
      eventType,
      payload,
      lastError,
      attempts: attemptsTotal,
    });
  }

  private async send(webhook: WebhookRecord, body: string): Promise<void> {
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref();

    try {
      const response = await this.fetchImpl(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook endpoint returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
