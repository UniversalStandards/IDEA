import { randomUUID } from 'crypto';

export interface PoolConnectionHandle {
  close?: () => void;
}

export interface ConnectionLease {
  readonly allowed: boolean;
  readonly clientId: string;
  readonly connectionId: string;
}

export interface ConnectionPoolOptions {
  readonly maxConnectionsPerClient: number;
}

export class ConnectionPool {
  private readonly connections = new Map<string, Map<string, PoolConnectionHandle>>();

  constructor(private readonly options: ConnectionPoolOptions) {}

  acquire(clientId: string, connection: PoolConnectionHandle = {}): ConnectionLease {
    const normalizedClientId = this.normalizeClientId(clientId);
    const existing = this.connections.get(normalizedClientId) ?? new Map<string, PoolConnectionHandle>();
    if (existing.size >= this.options.maxConnectionsPerClient) {
      return {
        allowed: false,
        clientId: normalizedClientId,
        connectionId: '',
      };
    }

    const connectionId = randomUUID();
    existing.set(connectionId, connection);
    this.connections.set(normalizedClientId, existing);

    return {
      allowed: true,
      clientId: normalizedClientId,
      connectionId,
    };
  }

  release(clientId: string, connectionId: string): void {
    const normalizedClientId = this.normalizeClientId(clientId);
    const existing = this.connections.get(normalizedClientId);
    if (!existing) {
      return;
    }

    existing.delete(connectionId);
    if (existing.size === 0) {
      this.connections.delete(normalizedClientId);
    }
  }

  getConnectionCount(clientId: string): number {
    return this.connections.get(this.normalizeClientId(clientId))?.size ?? 0;
  }

  getTotalConnectionCount(): number {
    return [...this.connections.values()].reduce((total, clientConnections) => total + clientConnections.size, 0);
  }

  closeClientConnections(clientId: string): void {
    const normalizedClientId = this.normalizeClientId(clientId);
    const existing = this.connections.get(normalizedClientId);
    if (!existing) {
      return;
    }

    for (const handle of existing.values()) {
      handle.close?.();
    }
    this.connections.delete(normalizedClientId);
  }

  clear(): void {
    const clientIds = Array.from(this.connections.keys());
    for (const clientId of clientIds) {
      this.closeClientConnections(clientId);
    }
  }

  private normalizeClientId(clientId: string): string {
    return clientId.trim() || 'anonymous';
  }
}
