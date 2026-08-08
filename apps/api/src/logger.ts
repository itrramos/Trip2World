import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Structured logging.
 *
 * The redaction list below is the important part of this file. Trip2World logs request
 * bodies and headers on error, and without redaction a single 500 on the login route
 * would write a plaintext password into the log file — where it is then backed up,
 * shipped to whatever aggregator is configured, and retained far longer than any
 * password should be.
 *
 * Redaction is applied by pino at serialization time, so it covers accidental logging
 * from anywhere in the process, not just the call sites we remembered to sanitise.
 */

const REDACTED_PATHS = [
  // Credentials in request bodies.
  'password',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.confirmPassword',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.confirmPassword',

  // Tokens anywhere.
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.tokenHash',
  '*.passwordHash',

  // Auth material on the wire.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',

  // Secrets that could be logged from config.
  '*.JWT_SECRET',
  '*.SESSION_SECRET',
  '*.TURN_SECRET',
  '*.IP_HASH_SALT',
  '*.SMTP_PASSWORD',
  '*.DATABASE_URL',
  '*.REDIS_URL',
  '*.credential',
];

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },

    // ISO timestamps rather than epoch millis — these are read by humans during an
    // incident far more often than they are parsed by a machine.
    timestamp: stdTimeFunctions.isoTime,

    base: { service: 'api' },

    formatters: {
      level: (label) => ({ level: label }),
    },

    serializers: {
      req(request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        id?: string;
      }) {
        return {
          id: request.id,
          method: request.method,
          // Strip the query string: password-reset and email-verification tokens
          // arrive as query parameters and must never be persisted to a log.
          url: request.url.split('?')[0],
          userAgent: request.headers['user-agent'],
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
      err: stdSerializers.err,
    },
  };

  // Pretty output in development only; production emits newline-delimited JSON for
  // whatever collector is in front of it.
  //
  // pino-pretty is a dev dependency and is pruned from the production image. If someone
  // starts a pruned image with NODE_ENV=development, pino throws "unable to determine
  // transport target" at construction and the process dies before it can log why — so
  // fall back to JSON rather than making log formatting a startup dependency.
  if (config.isDevelopment) {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      });
    } catch {
      // Fall through to plain JSON.
    }
  }

  return pino(options);
}

export type { Logger };
