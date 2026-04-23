/**
 * src/observability/log-streamer.ts
 * A custom Winston transport that re-emits log entries to an EventEmitter
 * so SSE clients can subscribe to a live log tail.
 *
 * Usage:
 *   import { logStreamer, LogStreamTransport } from './log-streamer';
 *   // logStreamer.on('log', (entry) => { ... })
 */

import { EventEmitter } from 'events';
import Transport from 'winston-transport';

export interface LogStreamEntry {
  level: string;
  message: string;
  module?: string;
  timestamp?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Singleton EventEmitter that broadcasts every log entry written through
 * the LogStreamTransport.  SSE handlers subscribe to the 'log' event.
 */
class LogStreamer extends EventEmitter {
  constructor() {
    super();
    // Allow many SSE connections without hitting the default listener-count warning
    this.setMaxListeners(200);
  }

  push(entry: LogStreamEntry): void {
    this.emit('log', entry);
  }
}

export const logStreamer = new LogStreamer();

/**
 * Winston Transport that forwards every log message to logStreamer.
 * Add this transport to the rootLogger in logger.ts.
 */
export class LogStreamTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Winston info type is effectively any
  override log(info: any, callback: () => void): void {
    setImmediate(() => {
      logStreamer.push(info as LogStreamEntry);
      this.emit('logged', info);
    });
    callback();
  }
}
