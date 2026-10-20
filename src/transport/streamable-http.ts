/**
 * src/transport/streamable-http.ts
 * MCP Streamable HTTP transport (MCP spec 2025-06-18) mounted on the hub's
 * Express app.
 *
 * - One MCPAdapter (and therefore one McpServer) per MCP session, so
 *   server→client requests such as elicitation reach the right client.
 * - Stateful sessions keyed by the `Mcp-Session-Id` header; unknown/expired
 *   sessions get 404 so compliant clients re-initialize automatically.
 * - Bearer authentication: a static MCP_AUTH_TOKEN, or a JWT signed with
 *   JWT_SECRET (worker-session tokens are rejected).
 * - Optional DNS-rebinding protection via MCP_ALLOWED_HOSTS.
 * - Bounded resources: MCP_MAX_SESSIONS and an idle-session reaper.
 */

import { randomUUID } from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Config } from '../config';
import { MCPAdapter } from '../adapters/mcp/index';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { constantTimeEqual } from '../security/crypto';
import { isTransportAuthorized } from './middleware/auth';
import type { ITransport } from './index';

const logger = createLogger('streamable-http-transport');

export type StreamableHttpConfig = Pick<
  Config,
  | 'NODE_ENV'
  | 'JWT_SECRET'
  | 'MCP_HTTP_PATH'
  | 'MCP_AUTH_TOKEN'
  | 'MCP_ALLOW_UNAUTHENTICATED'
  | 'MCP_ALLOWED_HOSTS'
  | 'MCP_MAX_SESSIONS'
  | 'MCP_SESSION_IDLE_TIMEOUT_MS'
>;

/** The subset of MCPAdapter this transport depends on (eases testing). */
export interface McpSessionAdapter {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface StreamableHttpTransportOptions {
  readonly app: Express;
  readonly config: StreamableHttpConfig;
  readonly adapterFactory?: () => McpSessionAdapter;
  readonly now?: () => number;
}

interface McpSession {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly adapter: McpSessionAdapter;
  lastSeenAt: number;
}

// JSON-RPC error codes used on the HTTP layer (outside the JSON-RPC session).
const JSONRPC_SERVER_ERROR = -32000;
const JSONRPC_UNAUTHORIZED = -32001;

export type McpAuthDecision = 'ok' | 'unauthorized';

/**
 * Decide whether a request may use the MCP endpoint.
 * With no MCP_AUTH_TOKEN configured the endpoint is open outside production;
 * in production config validation already guarantees a token is configured
 * unless MCP_ALLOW_UNAUTHENTICATED=true was set explicitly.
 */
export function authorizeMcpRequest(
  authorization: string | undefined,
  cfg: Pick<Config, 'NODE_ENV' | 'JWT_SECRET' | 'MCP_AUTH_TOKEN' | 'MCP_ALLOW_UNAUTHENTICATED'>,
): McpAuthDecision {
  const bearer = authorization?.startsWith('Bearer ') === true ? authorization.slice(7).trim() : undefined;

  if (bearer !== undefined && bearer.length > 0) {
    if (cfg.MCP_AUTH_TOKEN !== undefined && constantTimeEqual(bearer, cfg.MCP_AUTH_TOKEN)) {
      return 'ok';
    }
    if (isTransportAuthorized({ authorization, config: cfg })) {
      return 'ok';
    }
    return 'unauthorized';
  }

  if (cfg.MCP_AUTH_TOKEN === undefined && (cfg.NODE_ENV !== 'production' || cfg.MCP_ALLOW_UNAUTHENTICATED)) {
    return 'ok';
  }
  return 'unauthorized';
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

export class StreamableHttpTransport implements ITransport {
  readonly name = 'streamable-http' as const;
  private readonly sessions = new Map<string, McpSession>();
  private readonly adapterFactory: () => McpSessionAdapter;
  private readonly now: () => number;
  private readonly allowedHosts: string[];
  private reaper: NodeJS.Timeout | undefined;
  private initialized = false;

  constructor(private readonly options: StreamableHttpTransportOptions) {
    this.adapterFactory = options.adapterFactory ?? ((): McpSessionAdapter => new MCPAdapter());
    this.now = options.now ?? Date.now;
    this.allowedHosts = parseAllowedHosts(options.config.MCP_ALLOWED_HOSTS);
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    const { app, config } = this.options;
    const path = config.MCP_HTTP_PATH;
    const auth = this.authenticate.bind(this);

    app.post(path, auth, (req: Request, res: Response) => {
      void this.handlePost(req, res);
    });
    app.get(path, auth, (req: Request, res: Response) => {
      void this.handleSessionRequest(req, res);
    });
    app.delete(path, auth, (req: Request, res: Response) => {
      void this.handleSessionRequest(req, res);
    });

    this.initialized = true;
    logger.info('MCP Streamable HTTP endpoint mounted', {
      path,
      auth: config.MCP_AUTH_TOKEN !== undefined ? 'bearer-token+jwt' : 'jwt-or-open',
      dnsRebindingProtection: this.allowedHosts.length > 0,
      maxSessions: config.MCP_MAX_SESSIONS,
    });
    return Promise.resolve();
  }

  start(): Promise<void> {
    if (!this.reaper) {
      const idleMs = this.options.config.MCP_SESSION_IDLE_TIMEOUT_MS;
      this.reaper = setInterval(() => {
        void this.reapIdleSessions();
      }, Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))));
      this.reaper.unref();
    }
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => this.closeSession(s, 'shutdown')));
    metrics.gauge('mcp_http_sessions_active', 0);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Close sessions with no request for MCP_SESSION_IDLE_TIMEOUT_MS. */
  async reapIdleSessions(): Promise<number> {
    const cutoff = this.now() - this.options.config.MCP_SESSION_IDLE_TIMEOUT_MS;
    const idle = Array.from(this.sessions.values()).filter((s) => s.lastSeenAt < cutoff);
    for (const s of idle) {
      this.sessions.delete(s.id);
    }
    await Promise.allSettled(idle.map((s) => this.closeSession(s, 'idle-timeout')));
    if (idle.length > 0) {
      metrics.gauge('mcp_http_sessions_active', this.sessions.size);
    }
    return idle.length;
  }

  private authenticate(req: Request, res: Response, next: NextFunction): void {
    const decision = authorizeMcpRequest(req.headers['authorization'], this.options.config);
    if (decision === 'ok') {
      next();
      return;
    }
    metrics.increment('mcp_http_auth_failures_total');
    res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
    sendJsonRpcError(res, 401, JSONRPC_UNAUTHORIZED, 'Unauthorized: a valid Bearer token is required');
  }

  private sessionIdOf(req: Request): string | undefined {
    const header = req.headers['mcp-session-id'];
    return typeof header === 'string' && header.length > 0 ? header : undefined;
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = this.sessionIdOf(req);
      if (sessionId !== undefined) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          sendJsonRpcError(res, 404, JSONRPC_UNAUTHORIZED, 'Session not found or expired; re-initialize');
          return;
        }
        session.lastSeenAt = this.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendJsonRpcError(
          res,
          400,
          JSONRPC_SERVER_ERROR,
          'Bad Request: Mcp-Session-Id header is required for non-initialize requests',
        );
        return;
      }

      if (this.sessions.size >= this.options.config.MCP_MAX_SESSIONS) {
        metrics.increment('mcp_http_sessions_rejected_total', { reason: 'capacity' });
        res.setHeader('Retry-After', '30');
        sendJsonRpcError(res, 503, JSONRPC_SERVER_ERROR, 'Session capacity reached; retry later');
        return;
      }

      await this.createSession(req, res);
    } catch (err) {
      logger.error('MCP HTTP request failed', { err: err instanceof Error ? err.message : String(err) });
      sendJsonRpcError(res, 500, JSONRPC_SERVER_ERROR, 'Internal server error');
    }
  }

  private async handleSessionRequest(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = this.sessionIdOf(req);
      if (sessionId === undefined) {
        sendJsonRpcError(res, 400, JSONRPC_SERVER_ERROR, 'Bad Request: Mcp-Session-Id header is required');
        return;
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, JSONRPC_UNAUTHORIZED, 'Session not found or expired; re-initialize');
        return;
      }
      session.lastSeenAt = this.now();
      await session.transport.handleRequest(req, res);
    } catch (err) {
      logger.error('MCP HTTP session request failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      sendJsonRpcError(res, 500, JSONRPC_SERVER_ERROR, 'Internal server error');
    }
  }

  private async createSession(req: Request, res: Response): Promise<void> {
    const adapter = this.adapterFactory();
    let session: McpSession | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => randomUUID(),
      ...(this.allowedHosts.length > 0
        ? { enableDnsRebindingProtection: true, allowedHosts: this.allowedHosts }
        : {}),
      onsessioninitialized: (id: string): void => {
        session = { id, transport, adapter, lastSeenAt: this.now() };
        this.sessions.set(id, session);
        metrics.increment('mcp_http_sessions_created_total');
        metrics.gauge('mcp_http_sessions_active', this.sessions.size);
        logger.info('MCP HTTP session opened', { sessionId: id, active: this.sessions.size });
      },
    });

    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id !== undefined && this.sessions.get(id)?.transport === transport) {
        this.sessions.delete(id);
        metrics.gauge('mcp_http_sessions_active', this.sessions.size);
        logger.info('MCP HTTP session closed', { sessionId: id, active: this.sessions.size });
      }
    };

    // The SDK's StreamableHTTPServerTransport declares its callbacks as
    // `T | undefined`, which its own Transport interface rejects under
    // exactOptionalPropertyTypes; the runtime contract is identical.
    await adapter.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body);

    // If the initialize request was rejected (e.g. DNS-rebinding check), no
    // session was created; release the adapter's resources.
    if (session === undefined) {
      await adapter.close();
    }
  }

  private async closeSession(session: McpSession, reason: string): Promise<void> {
    try {
      await session.adapter.close();
    } catch (err) {
      logger.warn('Error closing MCP session', {
        sessionId: session.id,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('MCP HTTP session ended', { sessionId: session.id, reason });
  }
}
