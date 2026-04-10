/**
 * src/adapters/graphql/index.ts
 * Adapter that exposes remote GraphQL endpoints as MCP tools.
 * Supports runtime endpoint registration, introspection, and credential injection.
 */

import axios from 'axios';
import { createLogger } from '../../observability/logger';
import { auditLog } from '../../security/audit';
import type { IAdapter } from '../../types/index';

const logger = createLogger('graphql-adapter');

// ─────────────────────────────────────────────────────────────────

export interface GraphQLEndpointConfig {
  readonly id: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly introspectionEnabled?: boolean;
}

export interface GraphQLOperation {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string;
}

export interface GraphQLError {
  readonly message: string;
  readonly path?: string[];
  readonly locations?: Array<{ line: number; column: number }>;
}

export interface GraphQLResponse {
  readonly data?: unknown;
  readonly errors?: GraphQLError[];
}

// ─────────────────────────────────────────────────────────────────

export class GraphQLAdapter implements IAdapter {
  readonly name = 'graphql';
  readonly protocol = 'graphql';

  private readonly endpoints = new Map<string, GraphQLEndpointConfig>();

  async initialize(): Promise<void> {
    logger.info('GraphQL adapter initialized', { endpoints: this.endpoints.size });
  }

  async shutdown(): Promise<void> {
    logger.info('GraphQL adapter shut down');
  }

  /** Register a GraphQL endpoint for use as an MCP tool source. */
  registerEndpoint(cfg: GraphQLEndpointConfig): void {
    this.endpoints.set(cfg.id, cfg);
    logger.debug('GraphQL endpoint registered', { id: cfg.id, url: cfg.url });
  }

  /** Deregister a GraphQL endpoint by ID. */
  deregisterEndpoint(id: string): boolean {
    return this.endpoints.delete(id);
  }

  getEndpoints(): GraphQLEndpointConfig[] {
    return Array.from(this.endpoints.values());
  }

  /**
   * Execute a GraphQL operation against a registered endpoint.
   * @param endpointId Registered endpoint ID
   * @param operation  GraphQL query/mutation/subscription + variables
   * @param requestId  Optional correlation ID for audit log
   */
  async execute(
    endpointId: string,
    operation: GraphQLOperation,
    requestId?: string,
  ): Promise<GraphQLResponse> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`GraphQL endpoint '${endpointId}' not found. Register it first with registerEndpoint().`);
    }

    const startTime = Date.now();
    let outcome: 'success' | 'failure' = 'success';

    try {
      const response = await axios.post<GraphQLResponse>(
        endpoint.url,
        {
          query: operation.query,
          variables: operation.variables,
          operationName: operation.operationName,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...endpoint.headers,
          },
          timeout: endpoint.timeoutMs ?? 30_000,
        },
      );

      if (response.data.errors && response.data.errors.length > 0) {
        outcome = 'failure';
        logger.warn('GraphQL response contained errors', {
          endpointId,
          errorCount: response.data.errors.length,
          firstError: response.data.errors[0]?.message,
        });
      }

      return response.data;
    } catch (err) {
      outcome = 'failure';
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GraphQL request failed', { endpointId, err: msg });
      throw new Error(`GraphQL request to '${endpointId}' failed: ${msg}`);
    } finally {
      const durationMs = Date.now() - startTime;
      auditLog.record(
        'graphql.operation.executed',
        'system',
        endpointId,
        outcome,
        requestId,
        { operationName: operation.operationName, durationMs },
      );
    }
  }

  /**
   * Introspect the schema of a registered GraphQL endpoint.
   * Returns the full introspection result as returned by the server.
   */
  async introspect(endpointId: string, requestId?: string): Promise<GraphQLResponse> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`GraphQL endpoint '${endpointId}' not found`);
    }
    if (endpoint.introspectionEnabled === false) {
      throw new Error(`Introspection is disabled for endpoint '${endpointId}'`);
    }

    const introspectionQuery = `
      query IntrospectionQuery {
        __schema {
          queryType { name }
          mutationType { name }
          subscriptionType { name }
          types {
            name
            kind
            description
            fields(includeDeprecated: true) {
              name
              description
              type { name kind }
              isDeprecated
              deprecationReason
            }
          }
        }
      }
    `;

    return this.execute(
      endpointId,
      { query: introspectionQuery, operationName: 'IntrospectionQuery' },
      requestId,
    );
  }
}

/** Singleton instance for use across the application. */
export const graphqlAdapter = new GraphQLAdapter();
