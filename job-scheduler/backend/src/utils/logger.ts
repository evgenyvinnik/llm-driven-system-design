/**
 * Logger module providing structured JSON logging for the job scheduler.
 * Uses Pino for high-performance, low-overhead structured logging.
 * In development, logs are pretty-printed; in production, they are JSON lines.
 * @module utils/logger
 */

import pino from 'pino';

/** Log level from environment, defaults to 'info' */
const logLevel = process.env.LOG_LEVEL || 'info';

/** Whether we are in development mode */
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Base Pino logger instance configured for the job scheduler.
 * Includes timestamp, service metadata, and error serialization.
 * Uses pino-pretty in development for human-readable output.
 */
const pinoLogger = pino({
  level: logLevel,
  base: {
    service: process.env.SERVICE_NAME || 'job-scheduler',
    instance: process.env.WORKER_ID || process.env.SCHEDULER_INSTANCE_ID || 'unknown',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      service: bindings.service,
      instance: bindings.instance,
      pid: bindings.pid,
      hostname: bindings.hostname,
    }),
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

/**
 * Log levels available for structured logging.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Logger interface that wraps Pino with a more flexible API.
 * Supports both Pino-style (object, message) and Winston-style (message, error) calls.
 */
export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child: (bindings: Record<string, unknown>) => Logger;
}

/**
 * Flexible log function signature.
 * Supports multiple calling conventions:
 * - logger.info('message')
 * - logger.info({ key: value }, 'message')
 * - logger.error('message', error)
 */
type LogFn = {
  (msg: string): void;
  (obj: Record<string, unknown>, msg?: string): void;
  (msg: string, error: unknown): void;
};

/**
 * Creates a logger function that handles multiple calling conventions.
 */
function createLogFn(pinoFn: pino.LogFn): LogFn {
  return function (msgOrObj: string | Record<string, unknown>, msgOrError?: string | unknown): void {
    if (typeof msgOrObj === 'string') {
      if (msgOrError === undefined) {
        // logger.info('message')
        pinoFn(msgOrObj);
      } else if (msgOrError instanceof Error) {
        // logger.error('message', error)
        pinoFn({ err: msgOrError }, msgOrObj);
      } else if (typeof msgOrError === 'object' && msgOrError !== null) {
        // logger.error('message', errorObject)
        pinoFn({ err: msgOrError }, msgOrObj);
      } else {
        // logger.info('message', someValue)
        pinoFn({ value: msgOrError }, msgOrObj);
      }
    } else {
      // logger.info({ key: value }, 'message')
      pinoFn(msgOrObj, msgOrError as string);
    }
  } as LogFn;
}

/**
 * Creates a wrapped logger from a Pino instance.
 */
function createLogger(pinoInst: pino.Logger): Logger {
  return {
    trace: createLogFn(pinoInst.trace.bind(pinoInst)),
    debug: createLogFn(pinoInst.debug.bind(pinoInst)),
    info: createLogFn(pinoInst.info.bind(pinoInst)),
    warn: createLogFn(pinoInst.warn.bind(pinoInst)),
    error: createLogFn(pinoInst.error.bind(pinoInst)),
    fatal: createLogFn(pinoInst.fatal.bind(pinoInst)),
    child: (bindings: Record<string, unknown>) => createLogger(pinoInst.child(bindings)),
  };
}

/**
 * Main logger instance for the job scheduler.
 */
export const logger: Logger = createLogger(pinoLogger);

/**
 * Creates a child logger with additional context.
 * Useful for adding request-specific or job-specific metadata.
 * @param bindings - Additional context to include in all log entries
 * @returns Child logger instance
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * Structured log entry interface for consistent logging.
 */
export interface LogEntry {
  message: string;
  level: LogLevel;
  timestamp: string;
  service: string;
  instance: string;
  [key: string]: unknown;
}
