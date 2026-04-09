import * as winston from 'winston';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../observability/logger';

const logger = createLogger('audit');

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: 'success' | 'failure' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
}

export type AuditFilter = Partial<
  Pick<AuditEvent, 'actor' | 'action' | 'resource' | 'outcome'>
> & {
  from?: string;
  to?: string;
};

const auditFileTransport = new winston.transports.File({
  filename: path.resolve(process.cwd(), 'audit.log'),
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  maxsize: 50 * 1024 * 1024,
  maxFiles: 10,
  tailable: true,
});

const auditWinston = winston.createLogger({
  level: 'info',
  transports: [auditFileTransport],
  exitOnError: false,
});

export class AuditLogger {
  private readonly events: AuditEvent[] = [];
  private readonly maxEvents = 100_000;

  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }
    this.events.push(full);

    auditWinston.info('audit', full);
    logger.debug('Audit event recorded', { id: full.id, action: full.action, actor: full.actor });

    return full;
  }

  query(filter: AuditFilter = {}): AuditEvent[] {
    return this.events.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.action && e.action !== filter.action) return false;
      if (filter.resource && e.resource !== filter.resource) return false;
      if (filter.outcome && e.outcome !== filter.outcome) return false;
      if (filter.from && e.timestamp < filter.from) return false;
      if (filter.to && e.timestamp > filter.to) return false;
      return true;
    });
  }

  export(): AuditEvent[] {
    return [...this.events];
  }

  count(): number {
    return this.events.length;
  }
}

export const auditLogger = new AuditLogger();
