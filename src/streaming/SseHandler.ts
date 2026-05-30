import type { Request, Response } from 'express';

type SseClient = {
  readonly orgId: string;
  readonly response: Response;
};

export class SseHandler {
  private readonly clients = new Set<SseClient>();

  connect(orgId: string, req: Request, res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const client: SseClient = { orgId, response: res };
    this.clients.add(client);
    res.write(`event: connected\ndata: ${JSON.stringify({ orgId })}\n\n`);

    req.on('close', () => {
      this.clients.delete(client);
    });
  }

  publish(orgId: string, event: string, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.orgId !== orgId) {
        continue;
      }
      client.response.write(`event: ${event}\n`);
      client.response.write(`data: ${body}\n\n`);
    }
  }
}

export const sseHandler = new SseHandler();
