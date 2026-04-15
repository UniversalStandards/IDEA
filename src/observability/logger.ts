/**
 * src/observability/logger.ts
 * Structured Winston logger with:
 * - JSON format in production, colorized in development
 * - Daily log rotation (winston-daily-rotate-file)
 * - Automatic redaction of sensitive fields
 * - requestId support for traceability
 */

import { createLogger as winstonCreateLogger, format, transports, type Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// ─────────────────────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
  'authorization', 'auth', 'key', 'private_key', 'privatekey',
  'credential', 'credentials', 'jwt', 'bearer', 'access_token',
  'refresh_token', 'client_secret', 'encryption_key',
]);

const REDACTED = '[REDACTED]';

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 10 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = REDACTED;
    } else {
      result[k] = redactSensitive(v, depth + 1);
    }
  }
  return result;
}

const redactFormat = format((info) => {
  return redactSensitive(info) as typeof info;
});

// ─────────────────────────────────────────────────────────────────
const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const logLevel = process.env['LOG_LEVEL'] ?? (nodeEnv === 'production' ? 'info' : 'debug');
const logsDir = path.join(process.cwd(), 'logs');

if (nodeEnv !== 'test') {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // Non-fatal — file transport will fail silently if dir cannot be created
  }
}

const productionTransports = [
  new DailyRotateFile({
    dirname: logsDir,
    filename: 'mcp-hub-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    format: format.combine(
      redactFormat(),
      format.timestamp(),
      format.json(),
    ),
  }),
  new DailyRotateFile({
    dirname: logsDir,
    filename: 'mcp-hub-error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    zippedArchive: true,
    maxSize: '10m',
    maxFiles: '30d',
    format: format.combine(
      redactFormat(),
      format.timestamp(),
      format.json(),
    ),
  }),
];

// Determine if we should use colorized output (TTY + development)
const useColorizedOutput = nodeEnv !== 'production' && process.stdout.isTTY;

const consoleTransport = new transports.Console({
  format:
    useColorizedOutput
      ? format.combine(
          redactFormat(),
          format.colorize({ all: true }),
          format.timestamp({ format: 'HH:mm:ss' }),
          format.printf(({ timestamp, level, message, module: mod, ...rest }) => {
            const meta = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
            return `${String(timestamp)} [${String(mod ?? 'app')}] ${level}: ${String(message)}${meta}`;
          }),
        )
      : format.combine(redactFormat(), format.timestamp(), format.json()),
});

const rootLogger = winstonCreateLogger({
  level: logLevel,
  defaultMeta: { service: 'mcp-hub' },
  transports:
    nodeEnv === 'test'
      ? [] // Suppress all output in tests
      : nodeEnv === 'production'
        ? [...productionTransports, consoleTransport]
        : [consoleTransport],
  silent: nodeEnv === 'test',
});

// ─────────────────────────────────────────────────────────────────

export type ModuleLogger = Logger;

/**
 * Creates a child logger scoped to a specific module.
 * Automatically includes `module` field in every log entry.
 */
export function createLogger(moduleName: string): Logger {
  return rootLogger.child({ module: moduleName });
}

/**
 * Creates a request-scoped child logger that includes requestId and correlationId.
 */
export function createRequestLogger(
  moduleName: string,
  requestId: string,
  correlationId?: string,
): Logger {
  return rootLogger.child({ module: moduleName, requestId, correlationId });
}

export { rootLogger };
