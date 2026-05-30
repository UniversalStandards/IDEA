import { z } from 'zod';
import { StreamEventType } from '../streaming.types';

export const StreamEventSchema = z.object({
  streamId: z.string().min(1),
  orgId: z.string().min(1),
  eventType: z.nativeEnum(StreamEventType),
  sequence: z.number().int().nonnegative(),
  data: z.object({}).catchall(z.unknown()),
  timestamp: z.string().min(1),
});

export const StreamMetaSchema = z.object({
  streamId: z.string().min(1),
  protocol: z.enum(['sse', 'websocket', 'grpc', 'http']),
  createdAt: z.string().min(1),
  status: z.enum(['open', 'closed', 'errored']),
});

export const StreamChunkSchema = z.object({
  streamId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  content: z.string(),
  timestamp: z.string().min(1),
  isFinal: z.boolean().optional(),
});

export const StreamOptionsSchema = z.object({
  protocol: z.enum(['sse', 'websocket', 'grpc', 'http']),
  includeMetadata: z.boolean().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  maxBufferedEvents: z.number().int().positive().optional(),
});
