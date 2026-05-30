import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { getConfig } from '../../config';
import { createLogger } from '../../observability/logger';
import { WebhookDelivery } from './WebhookDelivery';
import {
  WebhookEventTypeSchema,
  type WebhookEventType,
  type WebhookStore,
  webhookStore,
} from './WebhookStore';

const logger = createLogger('webhook-router');

const registerWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'Webhook URL must use HTTPS'),
  events: z.array(WebhookEventTypeSchema).min(1),
  secret: z.string().min(8).optional(),
});

declare module 'express-serve-static-core' {
  interface Request {
    webhookOrgId?: string;
  }
}

export interface WebhookRouterOptions {
  readonly store?: WebhookStore;
  readonly delivery?: WebhookDelivery;
  readonly jwtSecret?: string;
}

export function createWebhookRouter(options: WebhookRouterOptions = {}): Router {
  const cfg = getConfig();
  const jwtSecret = options.jwtSecret ?? cfg.JWT_SECRET;
  const store = options.store ?? webhookStore;
  const delivery = options.delivery ?? new WebhookDelivery({ store });
  const router = Router();

  void store.initialize();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers['authorization']);
    if (!token) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret) as JwtPayload | string;
      if (typeof decoded === 'string') {
        res.status(401).json({ error: 'Invalid JWT payload' });
        return;
      }
      const orgId = decodeOrgId(decoded);
      if (!orgId) {
        res.status(401).json({ error: 'Missing orgId claim in JWT' });
        return;
      }
      req.webhookOrgId = orgId;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  router.post('/webhooks', async (req: Request, res: Response) => {
    const parsed = registerWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid webhook payload', details: parsed.error.issues });
      return;
    }

    const orgId = req.webhookOrgId;
    if (!orgId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const created = await store.create({
      orgId,
      url: parsed.data.url,
      events: parsed.data.events,
      secret: parsed.data.secret ?? cfg.WEBHOOK_SECRET ?? cfg.JWT_SECRET,
    });

    res.status(201).json(created);
  });

  router.get('/webhooks', async (req: Request, res: Response) => {
    const orgId = req.webhookOrgId;
    if (!orgId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const hooks = await store.listByOrg(orgId);
    res.json({ webhooks: hooks, count: hooks.length });
  });

  router.delete('/webhooks/:id', async (req: Request, res: Response) => {
    const orgId = req.webhookOrgId;
    if (!orgId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const webhookIdParam = req.params['id'];
    const webhookId = typeof webhookIdParam === 'string' ? webhookIdParam : undefined;
    if (!webhookId) {
      res.status(400).json({ error: 'Missing webhook id' });
      return;
    }

    const existing = await store.get(webhookId);
    if (existing?.orgId !== orgId) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    const deleted = await store.delete(webhookId);
    res.json({ deleted });
  });

  router.post('/webhooks/deliver/:eventType', async (req: Request, res: Response) => {
    const orgId = req.webhookOrgId;
    if (!orgId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const eventTypeParsed = WebhookEventTypeSchema.safeParse(req.params['eventType']);
    if (!eventTypeParsed.success) {
      res.status(400).json({ error: 'Invalid event type', details: eventTypeParsed.error.issues });
      return;
    }

    const payload = isRecord(req.body) ? req.body : { value: req.body };
    await delivery.deliverToOrg(orgId, eventTypeParsed.data as WebhookEventType, payload);
    logger.info('Webhook delivery triggered', {
      orgId,
      eventType: eventTypeParsed.data,
    });
    res.status(202).json({ accepted: true });
  });

  return router;
}

function extractBearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  return authorization.slice(7).trim();
}

function decodeOrgId(payload: JwtPayload): string | undefined {
  const candidate = payload['orgId'] ?? payload['org_id'];
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
