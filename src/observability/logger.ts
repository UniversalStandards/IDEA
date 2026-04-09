import * as winston from 'winston';
import { config } from '../config';

const { combine, timestamp, label, printf, colorize, json, errors } = winston.format;

const devFormat = (moduleName: string) =>
  combine(
    errors({ stack: true }),
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    label({ label: moduleName }),
    printf(({ level, message, label: lbl, timestamp: ts, stack, ...meta }) => {
      const metaStr =
        Object.keys(meta).length > 0 ? `\n  ${JSON.stringify(meta, null, 2)}` : '';
      const stackStr = stack ? `\n${stack}` : '';
      return `${ts} [${lbl}] ${level}: ${message}${metaStr}${stackStr}`;
    }),
  );

const prodFormat = (moduleName: string) =>
  combine(
    errors({ stack: true }),
    timestamp(),
    label({ label: moduleName }),
    json(),
  );

function resolveLevel(): string {
  try {
    return config.LOG_LEVEL ?? 'info';
  } catch {
    return process.env['LOG_LEVEL'] ?? 'info';
  }
}

function isProduction(): boolean {
  try {
    return config.NODE_ENV === 'production';
  } catch {
    return process.env['NODE_ENV'] === 'production';
  }
}

export function createLogger(moduleName: string): winston.Logger {
  const prod = isProduction();
  const level = resolveLevel();

  const transports: winston.transport[] = [
    new winston.transports.Console({
      level,
      format: prod ? prodFormat(moduleName) : devFormat(moduleName),
    }),
  ];

  return winston.createLogger({
    level,
    defaultMeta: { module: moduleName },
    transports,
    exitOnError: false,
  });
}

export const rootLogger = createLogger('root');

export default rootLogger;
