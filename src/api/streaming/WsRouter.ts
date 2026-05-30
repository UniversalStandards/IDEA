import type { Server as HttpServer } from 'http';
import { Router, type Request, type Response } from 'express';
import { type WsStreamHandler, type WsStreamHandlerOptions } from '../../streaming/WsStreamHandler';
import { WsStreamHandler as DefaultWsStreamHandler } from '../../streaming/WsStreamHandler';

export interface WsRouterOptions {
  readonly handler?: WsStreamHandler;
  readonly handlerOptions?: WsStreamHandlerOptions;
}

export class WsRouter {
  readonly router: Router;
  private readonly handler: WsStreamHandler;

  constructor(options: WsRouterOptions) {
    this.handler = options.handler ?? new DefaultWsStreamHandler(options.handlerOptions ?? { jwtSecret: 'missing-secret' });
    this.router = Router();

    this.router.get('/ws', (_req: Request, res: Response) => {
      res.status(426).json({ error: 'Upgrade Required', detail: 'Use WebSocket protocol' });
    });
  }

  attach(server: HttpServer): void {
    this.handler.attach(server);
  }
}
