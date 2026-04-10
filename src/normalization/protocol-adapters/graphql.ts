/**
 * src/normalization/protocol-adapters/graphql.ts
 * Normalizes GraphQL operation requests to the internal NormalizedRequest format.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { IProtocolAdapter, NormalizedRequest, NormalizedResult } from '../../types/index';

const GraphQLRequestSchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.unknown()).optional(),
  operationName: z.string().optional(),
  extensions: z.record(z.unknown()).optional(),
});

export class GraphQLProtocolAdapter implements IProtocolAdapter {
  readonly protocol = 'graphql';

  normalize(raw: unknown): NormalizedRequest {
    const parsed = GraphQLRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid GraphQL request: ${parsed.error.message}`);
    }
    const { query, variables, operationName, extensions } = parsed.data;
    const operationType = this.detectOperationType(query);

    return {
      id: randomUUID(),
      method: operationName ?? operationType,
      params: { query, variables: variables ?? {} },
      protocol: this.protocol,
      version: 'june2018',
      requestedAt: new Date(),
      requestId: randomUUID(),
      metadata: { operationName, operationType, extensions },
    };
  }

  denormalize(result: NormalizedResult): unknown {
    if (!result.success) {
      return {
        data: null,
        errors: [{ message: result.error?.message ?? 'Unknown error' }],
      };
    }
    return { data: result.data };
  }

  private detectOperationType(query: string): string {
    const trimmed = query.trimStart().toLowerCase();
    if (trimmed.startsWith('mutation')) return 'mutation';
    if (trimmed.startsWith('subscription')) return 'subscription';
    return 'query';
  }
}

export const graphqlProtocolAdapter = new GraphQLProtocolAdapter();
