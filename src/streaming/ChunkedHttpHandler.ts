import type { Response } from 'express';
import { once } from 'node:events';
import { metrics } from '../observability/metrics';
import type { MetricsRegistry } from '../observability/metrics';

export interface ChunkedHttpHandlerOptions {
  readonly metricsRegistry?: MetricsRegistry;
}

export class ChunkedHttpHandler {
  private readonly metricsRegistry: MetricsRegistry;

  constructor(options: ChunkedHttpHandlerOptions = {}) {
    this.metricsRegistry = options.metricsRegistry ?? metrics;
  }

  initialize(res: Response, contentType = 'application/json; charset=utf-8'): void {
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
  }

  async streamChunks(
    res: Response,
    chunks: Iterable<string | Buffer> | AsyncIterable<string | Buffer>,
    labels: Record<string, string> = {},
  ): Promise<void> {
    const start = Date.now();
    let totalBytes = 0;

    for await (const chunk of chunks) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buffer.length;
      const shouldContinue = res.write(buffer);
      if (!shouldContinue) {
        await once(res, 'drain');
      }
    }

    res.end();

    const elapsed = Date.now() - start;
    if (elapsed > 0) {
      const bytesPerSecond = (totalBytes / elapsed) * 1000;
      this.metricsRegistry.gauge('stream_bytes_per_sec', bytesPerSecond, labels);
    }
  }
}
