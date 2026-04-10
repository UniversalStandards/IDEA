/**
 * src/adapters/events/index.ts
 * Webhook receiver and SSE stream adapter.
 * - POST /adapters/events/webhook — receives external webhook events
 * - GET  /adapters/events/stream  — Server-Sent Events stream for real-time delivery
 * Deduplicates events by event ID within the configured window.
 * Verifies HMAC-SHA256 webhook signatures when WEBHOOK_SECRET is configured.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../../observability/logger';
import { auditLog } from '../../security/audit';
import { verifyHmac } from '../../security/crypto';
import { getConfig } from '../../config';
import type { IAdapter } from '../../types/index';

const logger = createLogger('events-adapter');

// ─────────────────────────────────────────────────────────────────

const IncomingEventSchema = z.object({
  type: z.string().min(1).max(255),
  id: z.string().max(255).optional(),
  timestamp: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  source: z.string().optional(),
});

type IncomingEvent = z.infer<typeof IncomingEventSchema>;
type EventHandler = (event: IncomingEvent) => Promise<void>;

// ─────────────────────────────────────────────────────────────────

export class EventsAdapter implements IAdapter {
  readonly name = 'events';
  readonly protocol = 'events';

  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly dedupeCache = new Map<string, number>();
  private readonly sseClients = new Set<Response>();

  async initialize(): Promise<void> {
    logger.info('Events adapter initialized');
  }

  async shutdown(): Promise<void> {
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore — client already closed */ }
    }
    this.sseClients.clear();
    this.dedupeCache.clear();
    logger.info('Events adapter shut down');
  }

  /** Register a handler for a specific event type. */
  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /** Emit an event to all SSE clients and registered handlers. */
  async emit(event: IncomingEvent): Promise<void> {
    const fullEvent: IncomingEvent = {
      ...event,
      id: event.id ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    };

    // Broadcast to SSE clients
    const sseData = `data: ${JSON.stringify(fullEvent)}\n\n`;
    const deadClients: Response[] = [];
    for (const client of this.sseClients) {
      try {
        client.write(sseData);
      } catch {
        deadClients.push(client);
      }
    }
    for (const dead of deadClients) this.sseClients.delete(dead);

    // Invoke type-specific handlers
    const handlers = this.handlers.get(fullEvent.type) ?? [];
    const wildcardHandlers = this.handlers.get('*') ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];
    if (allHandlers.length > 0) {
      const results = await Promise.allSettled(allHandlers.map((h) => h(fullEvent)));
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        logger.warn('Event handler(s) failed', { eventType: fullEvent.type, failures: failures.length });
      }
    }
  }

  get sseClientCount(): number {
    return this.sseClients.size;
  }

  /** Build and return the Express router for this adapter. */
  buildRouter(): Router {
    const router = Router();

    // ── POST /adapters/events/webhook ────────────────────────────────
    router.post('/webhook', async (req: Request, res: Response) => {
      const cfg = getConfig();

      // Verify HMAC signature when WEBHOOK_SECRET is configured
      if (cfg.WEBHOOK_SECRET) {
        const signature = req.headers['x-webhook-signature'];
        if (typeof signature !== 'string') {
          res.status(401).json({ error: 'Missing X-Webhook-Signature header' });
          return;
        }
        const body = JSON.stringify(req.body);
        if (!verifyHmac(body, cfg.WEBHOOK_SECRET, signature)) {
          res.status(401).json({ error: 'Invalid webhook signature' });
          return;
        }
      }

      // Validate event payload
      const parsed = IncomingEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid event payload', details: parsed.error.issues });
        return;
      }

      const event = parsed.data;
      const eventId = event.id ?? randomUUID();

      // Idempotency: deduplicate by event ID within the configured window
      const now = Date.now();
      const windowMs = cfg.EVENT_DEDUP_WINDOW_MS;
      if (this.dedupeCache.has(eventId)) {
        logger.debug('Duplicate event rejected', { eventId, type: event.type });
        res.status(200).json({ status: 'duplicate', eventId });
        return;
      }
      this.dedupeCache.set(eventId, now);

      // Prune expired dedup entries to prevent unbounded growth
      for (const [id, ts] of this.dedupeCache.entries()) {
        if (now - ts > windowMs) this.dedupeCache.delete(id);
      }

      auditLog.record(
        'events.webhook.received',
        req.ip ?? 'external',
        event.type,
        'success',
        eventId,
        { source: event.source },
      );

      // Emit asynchronously — don't block the HTTP response
      void this.emit({ ...event, id: eventId });

      logger.info('Webhook event accepted', { type: event.type, eventId });
      res.status(202).json({ status: 'accepted', eventId });
    });

    // ── GET /adapters/events/stream (SSE) ───────────────────────────
    router.get('/stream', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      // Send a comment as the first frame to confirm the connection
      res.write(': connected\n\n');
      this.sseClients.add(res);
      logger.info('SSE client connected', { total: this.sseClients.size, ip: req.ip });

      // Heartbeat to prevent proxy/firewall timeouts (every 30s)
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 30_000);

      req.on('close', () => {
        clearInterval(heartbeatInterval);
        this.sseClients.delete(res);
        logger.debug('SSE client disconnected', { remaining: this.sseClients.size });
      });
    });

    return router;
  }
}

export const eventsAdapter = new EventsAdapter();
