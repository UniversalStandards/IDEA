/**
 * src/api/openapi.ts
 * Generates and serves the OpenAPI 3.1 specification for the Admin API.
 * Routes:
 *   GET /openapi.json — machine-readable spec
 *   GET /docs         — Swagger UI (development) / redirect to docs (production)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as swaggerUi from 'swagger-ui-express';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { createLogger } from '../observability/logger';

// Extend Zod with OpenAPI metadata support
extendZodWithOpenApi(z);

const logger = createLogger('openapi');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: pkgVersion } = require('../../package.json') as { version: string };

// ─────────────────────────────────────────────────────────────────
// Schema definitions (mirrors the validation schemas in admin-api.ts)
// ─────────────────────────────────────────────────────────────────

const CapabilitySchema = z
  .object({
    id: z.string().openapi({ example: 'tool-123' }),
    name: z.string().openapi({ example: 'My Tool' }),
  })
  .openapi('Capability');

const CapabilitiesResponseSchema = z
  .object({
    capabilities: z.array(CapabilitySchema),
    count: z.number().int().openapi({ example: 1 }),
  })
  .openapi('CapabilitiesResponse');

const DeregisterResponseSchema = z
  .object({
    message: z.string().openapi({ example: "Capability 'tool-123' deregistered successfully" }),
  })
  .openapi('DeregisterResponse');

const PoliciesResponseSchema = z
  .object({
    policies: z.array(z.unknown()),
    count: z.number().int().openapi({ example: 0 }),
    message: z.string().optional(),
  })
  .openapi('PoliciesResponse');

const CostsQuerySchema = z
  .object({
    windowHours: z.coerce.number().int().min(1).max(168).default(24).openapi({
      description: 'Time window in hours (1–168)',
      example: 24,
    }),
  })
  .openapi('CostsQuery');

const CostsResponseSchema = z
  .object({
    window: z.string().openapi({ example: '24h' }),
    windowMs: z.number().int().openapi({ example: 86400000 }),
    totalCostUsd: z.number().openapi({ example: 0 }),
    requestCount: z.number().int().openapi({ example: 0 }),
    byProvider: z.record(z.unknown()),
    byModel: z.record(z.unknown()),
    from: z.string().openapi({ example: '2025-04-22T20:00:00.000Z' }),
    to: z.string().openapi({ example: '2025-04-23T20:00:00.000Z' }),
  })
  .openapi('CostsResponse');

const AuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50).openapi({
      description: 'Maximum entries to return (1–500)',
      example: 50,
    }),
    offset: z.coerce.number().int().min(0).default(0).openapi({
      description: 'Number of entries to skip',
      example: 0,
    }),
    action: z.string().optional().openapi({
      description: 'Filter by action name',
      example: 'admin.capabilities.list',
    }),
  })
  .openapi('AuditQuery');

const AuditResponseSchema = z
  .object({
    entries: z.array(z.unknown()),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
    action: z.string().nullable(),
    total: z.number().int().openapi({ example: 0 }),
    message: z.string().optional(),
  })
  .openapi('AuditResponse');

const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ example: 'Something went wrong' }),
    details: z.array(z.unknown()).optional(),
  })
  .openapi('ErrorResponse');

const HealthStatusSchema = z
  .object({
    status: z.enum(['ok', 'degraded']).openapi({ example: 'ok' }),
    version: z.string().openapi({ example: '0.1.0' }),
    nodeVersion: z.string().openapi({ example: 'v20.0.0' }),
    environment: z.string().openapi({ example: 'production' }),
    uptimeSeconds: z.number().int().openapi({ example: 3600 }),
    timestamp: z.string().openapi({ example: '2026-04-23T20:00:00.000Z' }),
    checks: z.record(
      z.object({
        status: z.string(),
        message: z.string().optional(),
      }),
    ),
  })
  .openapi('HealthStatus');

// ─────────────────────────────────────────────────────────────────
// Registry setup
// ─────────────────────────────────────────────────────────────────

const registry = new OpenAPIRegistry();

// Register reusable components
registry.register('Capability', CapabilitySchema);
registry.register('CapabilitiesResponse', CapabilitiesResponseSchema);
registry.register('DeregisterResponse', DeregisterResponseSchema);
registry.register('PoliciesResponse', PoliciesResponseSchema);
registry.register('CostsQuery', CostsQuerySchema);
registry.register('CostsResponse', CostsResponseSchema);
registry.register('AuditQuery', AuditQuerySchema);
registry.register('AuditResponse', AuditResponseSchema);
registry.register('ErrorResponse', ErrorResponseSchema);
registry.register('HealthStatus', HealthStatusSchema);

// Security scheme — JWT Bearer
registry.registerComponent('securitySchemes', 'BearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT token issued and signed with JWT_SECRET. Include in Authorization header.',
});

// ─────────────────────────────────────────────────────────────────
// Health routes
// ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Combined health probe',
  description: 'Returns server and runtime health. 200 = healthy, 503 = degraded.',
  responses: {
    200: {
      description: 'Server is healthy',
      content: { 'application/json': { schema: HealthStatusSchema } },
    },
    503: {
      description: 'Server is degraded',
      content: { 'application/json': { schema: HealthStatusSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/live',
  tags: ['Health'],
  summary: 'Liveness probe',
  description: 'Always returns 200 if the process is running.',
  responses: {
    200: {
      description: 'Process is alive',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('ok'),
            timestamp: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/ready',
  tags: ['Health'],
  summary: 'Readiness probe',
  description: 'Returns 200 only when the runtime manager is fully initialized.',
  responses: {
    200: { description: 'Runtime is ready' },
    503: { description: 'Runtime not yet initialized' },
  },
});

// ─────────────────────────────────────────────────────────────────
// Admin routes (all require Bearer JWT)
// ─────────────────────────────────────────────────────────────────

const adminSecurity = [{ BearerAuth: [] as string[] }];

registry.registerPath({
  method: 'get',
  path: '/admin/capabilities',
  tags: ['Admin'],
  summary: 'List capabilities',
  description: 'Returns all capabilities currently registered in the runtime.',
  security: adminSecurity,
  responses: {
    200: {
      description: 'Capability list',
      content: { 'application/json': { schema: CapabilitiesResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid JWT',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/admin/capabilities/{id}',
  tags: ['Admin'],
  summary: 'Deregister a capability',
  description: 'Removes a capability from the runtime by ID.',
  security: adminSecurity,
  request: {
    params: z.object({ id: z.string().min(1).max(255).openapi({ example: 'tool-123' }) }),
  },
  responses: {
    200: {
      description: 'Capability deregistered',
      content: { 'application/json': { schema: DeregisterResponseSchema } },
    },
    400: {
      description: 'Invalid capability ID',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Capability not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/policies',
  tags: ['Admin'],
  summary: 'List policies',
  description: 'Returns the currently active policy rules.',
  security: adminSecurity,
  responses: {
    200: {
      description: 'Policy list',
      content: { 'application/json': { schema: PoliciesResponseSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/costs',
  tags: ['Admin'],
  summary: 'Cost summary',
  description: 'Returns per-provider and per-model cost aggregates for the given time window.',
  security: adminSecurity,
  request: { query: CostsQuerySchema },
  responses: {
    200: {
      description: 'Cost summary',
      content: { 'application/json': { schema: CostsResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/audit',
  tags: ['Admin'],
  summary: 'Audit log entries',
  description: 'Returns recent audit log entries with optional filtering and pagination.',
  security: adminSecurity,
  request: { query: AuditQuerySchema },
  responses: {
    200: {
      description: 'Audit entries',
      content: { 'application/json': { schema: AuditResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ─────────────────────────────────────────────────────────────────
// Spec generation (lazy, generated once on first request)
// ─────────────────────────────────────────────────────────────────

let _cachedSpec: OpenAPIObject | null = null;

export function generateSpec(serverUrl = 'http://localhost:3000'): OpenAPIObject {
  if (_cachedSpec) return _cachedSpec;

  const generator = new OpenApiGeneratorV31(registry.definitions);

  _cachedSpec = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Universal MCP Orchestration Hub — Admin API',
      version: pkgVersion,
      description:
        'REST Admin API for the Universal MCP Orchestration Hub. ' +
        'All `/admin/*` routes require a valid `Authorization: Bearer <JWT>` header. ' +
        'JWT tokens must be signed with the `JWT_SECRET` environment variable.',
      contact: {
        name: 'Universal Standards',
        url: 'https://github.com/UniversalStandards/IDEA',
      },
      license: {
        name: 'Apache-2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
    },
    servers: [{ url: serverUrl, description: 'MCP Orchestration Hub' }],
  });

  logger.debug('OpenAPI spec generated', { paths: Object.keys(_cachedSpec.paths ?? {}).length });
  return _cachedSpec;
}

/** Reset the cached spec (for testing). */
export function _resetSpecCache(): void {
  _cachedSpec = null;
}

// ─────────────────────────────────────────────────────────────────
// Express router
// ─────────────────────────────────────────────────────────────────

export const openapiRouter = Router();

/**
 * Build the server URL from configuration rather than trusting request headers.
 * The `PUBLIC_URL` env var takes precedence, then fallback to http://localhost:<PORT>.
 * Never trust the `Host` header to prevent Host header injection attacks.
 */
function getServerUrl(): string {
  const publicUrl = process.env['PUBLIC_URL'];
  if (publicUrl) return publicUrl.replace(/\/$/, '');
  const port = process.env['PORT'] ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * GET /openapi.json
 * Serves the generated OpenAPI 3.1 spec as JSON.
 * CORS is open (*) on this endpoint intentionally — the spec is static, schema-only
 * documentation that contains no credentials or user data. This lets external tools
 * (Swagger Editor, Postman, VS Code REST Client, etc.) fetch it without extra headers.
 */
openapiRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(generateSpec(getServerUrl()));
});

/**
 * GET /docs (and sub-paths)
 * Static assets for Swagger UI must be mounted first so CSS/JS bundles are served
 * before the HTML page handler is reached.
 *
 * In development: Swagger UI serves the interactive docs HTML page.
 * In production: redirects to /openapi.json for use with external viewers.
 */
openapiRouter.use('/docs', swaggerUi.serve);

openapiRouter.get('/docs', (req: Request, res: Response, next: NextFunction) => {
  const env = process.env['NODE_ENV'] ?? 'development';

  if (env === 'production') {
    res.redirect(301, '/openapi.json');
    return;
  }

  swaggerUi.setup(generateSpec(getServerUrl()))(req, res, next);
});
