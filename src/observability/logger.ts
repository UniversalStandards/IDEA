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
const TRUNCATED = '[TRUNCATED]';

export function redactSensitive(obj: unknown, depth = 0): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  // Past the depth limit the subtree can no longer be inspected for secrets, so
  // it is dropped rather than emitted unredacted (fail closed).
  if (depth > 10) return TRUNCATED;
  // Errors keep their non-enumerable name/message/stack/cause (a plain
  // Object.entries() rebuild would erase them) while every enumerable property
  // (e.g. an AxiosError's `config.headers.Authorization`) is still sanitized.
  if (obj instanceof Error) {
    const sanitized: Record<string, unknown> = {
      name: obj.name,
      message: obj.message,
      ...(obj.stack !== undefined ? { stack: obj.stack } : {}),
      ...(obj.cause !== undefined ? { cause: redactSensitive(obj.cause, depth + 1) } : {}),
    };
    for (const [k, v] of Object.entries(obj)) {
      sanitized[k] = SENSITIVE_KEYS.has(k.toLowerCase())
        ? REDACTED
        : redactSensitive(v, depth + 1);
    }
    return sanitized;
  }
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

/**
 * Redacts sensitive values IN PLACE on the winston `info` object.
 *
 * Winston stores its internals (level, message, splat) under Symbol keys that
 * downstream formats read (`colorize()` needs the Symbol(level) entry, `json()`
 * writes Symbol(message)). Rebuilding `info` from `Object.entries()` would drop
 * every Symbol key and crash the console transport on the first log line, so
 * only the string-keyed fields are rewritten and the original object is returned.
 */
export const redactFormat = format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactSensitive(info[key]);
  }
  return info;
});

// ─────────────────────────────────────────────────────────────────
const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const logLevel = process.env['LOG_LEVEL'] ?? (nodeEnv === 'production' ? 'info' : 'debug');
const logsDir = path.resolve(process.env['LOG_DIR'] ?? path.join(process.cwd(), 'logs'));
// File logging (production only) can be switched off for read-only or
// ephemeral containers where stderr/stdout is already collected.
const fileLoggingRequested = process.env['LOG_FILE_ENABLED'] !== 'false';

function ensureLogsDir(): boolean {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.accessSync(logsDir, fs.constants.W_OK);
    return true;
  } catch {
    // Not writable (e.g. a client launched the process from a system
    // directory): fall back to console-only logging instead of crashing.
    return false;
  }
}

const fileLoggingEnabled =
  nodeEnv === 'production' && fileLoggingRequested && ensureLogsDir();

const productionTransports = !fileLoggingEnabled ? [] : [
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

const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

/**
 * In stdio mode stdout carries the MCP JSON-RPC stream, so every console log
 * line must go to stderr instead — one log line on stdout corrupts the
 * protocol for the client. LOG_TO_STDERR=true forces the same routing in any
 * mode (useful under process managers that only capture stderr).
 */
export function shouldLogToStderr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MCP_TRANSPORT'] === 'stdio' || env['LOG_TO_STDERR'] === 'true';
}

const logToStderr = shouldLogToStderr();
const consoleStream = logToStderr ? process.stderr : process.stdout;
const useColor = consoleStream.isTTY === true && process.env['NO_COLOR'] === undefined;

const consoleTransport = new transports.Console({
  ...(logToStderr ? { stderrLevels: LOG_LEVELS } : {}),
  format:
    nodeEnv === 'production'
      ? format.combine(redactFormat(), format.timestamp(), format.json())
      : format.combine(
          redactFormat(),
          ...(useColor ? [format.colorize()] : []),
          format.timestamp({ format: 'HH:mm:ss' }),
          format.printf(({ timestamp, level, message, module: mod, ...rest }) => {
            const meta = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
            return `${String(timestamp)} [${String(mod ?? 'app')}] ${level}: ${String(message)}${meta}`;
          }),
        ),
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
