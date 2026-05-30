import type { IncomingMessage, Server as HttpServer } from 'http';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { URL } from 'url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

type WsConnection = {
  readonly orgId: string;
  readonly socket: WebSocket;
};

export interface WsStreamHandlerOptions {
  readonly jwtSecret: string;
  readonly path?: string;
  readonly onMessage?: (orgId: string, payload: unknown) => Promise<unknown>;
}

export class WsStreamHandler {
  private readonly path: string;
  private readonly server: WebSocketServer;
  private readonly connections = new Set<WsConnection>();
  private attached = false;

  constructor(private readonly options: WsStreamHandlerOptions) {
    this.path = options.path ?? '/api/v1/ws';
    this.server = new WebSocketServer({ noServer: true });

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage, orgId: string) => {
      this.handleConnection(socket, request, orgId);
    });
  }

  attach(server: HttpServer): void {
    if (this.attached) {
      return;
    }

    server.on('upgrade', (request, socket, head) => {
      const parsed = new URL(request.url ?? '/', 'http://localhost');
      if (parsed.pathname !== this.path) {
        return;
      }

      const orgId = this.authorizeRequest(request, parsed);
      if (!orgId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.server.emit('connection', ws, request, orgId);
      });
    });

    this.attached = true;
  }

  broadcastToOrg(orgId: string, payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    for (const connection of this.connections) {
      if (connection.orgId !== orgId) {
        continue;
      }
      connection.socket.send(serialized);
    }
  }

  private handleConnection(socket: WebSocket, _request: IncomingMessage, orgId: string): void {
    const connection: WsConnection = { orgId, socket };
    this.connections.add(connection);

    socket.send(JSON.stringify({ type: 'connected', orgId }));

    socket.on('message', (message: RawData) => {
      void this.handleMessage(connection, message);
    });

    socket.on('close', () => {
      this.connections.delete(connection);
    });

    socket.on('error', () => {
      this.connections.delete(connection);
    });
  }

  private async handleMessage(connection: WsConnection, message: RawData): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      connection.socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON payload' }));
      return;
    }

    if (!this.options.onMessage) {
      connection.socket.send(JSON.stringify({ type: 'ack' }));
      return;
    }

    try {
      const response = await this.options.onMessage(connection.orgId, payload);
      connection.socket.send(JSON.stringify({ type: 'response', data: response }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      connection.socket.send(JSON.stringify({ type: 'error', error }));
    }
  }

  private authorizeRequest(request: IncomingMessage, parsed: URL): string | undefined {
    const authHeader = request.headers['authorization'];
    const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    const queryToken = parsed.searchParams.get('token') ?? undefined;
    const token = headerToken ?? queryToken;
    if (!token) {
      return undefined;
    }

    try {
      const decoded = jwt.verify(token, this.options.jwtSecret) as JwtPayload | string;
      if (typeof decoded === 'string') {
        return undefined;
      }
      const claim = decoded['orgId'] ?? decoded['org_id'];
      return typeof claim === 'string' && claim.trim() ? claim : undefined;
    } catch {
      return undefined;
    }
  }
}
