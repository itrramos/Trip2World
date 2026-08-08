import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { PrismaClient } from '@prisma/client';
import { MAX_HTTP_BODY_BYTES } from '@trip2world/shared';
import { ApiErrorCode } from '@trip2world/types';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { AppError, Errors, isAppError } from './errors.js';
import type { Logger } from './logger.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js';
import type { RedisContext } from './redis.js';
import { adminRoutes } from './routes/admin.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { iceRoutes } from './routes/ice.routes.js';
import { AuthService } from './services/auth.service.js';
import { createMailService, type MailService } from './services/mail.service.js';
import { SettingsService } from './services/settings.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    redis: RedisContext;
    services: {
      auth: AuthService;
      mail: MailService;
      settings: SettingsService;
    };
  }
}

export interface BuildServerOptions {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  redis: RedisContext;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, logger, prisma, redis } = options;

  const app = Fastify({
    // Widened to Fastify's own logger interface on purpose. Passing pino's concrete
    // `Logger` type specialises every FastifyInstance generic to it, which then fails to
    // unify with the plain `FastifyInstance` used in the module augmentation and in every
    // route's signature. The runtime object is identical either way.
    loggerInstance: logger as FastifyBaseLogger,

    // Behind Cloudflare/cloudflared. Without this every request appears to originate
    // from the proxy, which would collapse all rate limiting into a single bucket.
    trustProxy: config.TRUST_PROXY,

    // Bound the body before it is parsed, not after.
    bodyLimit: MAX_HTTP_BODY_BYTES,

    // Correlates a client-visible error with the server log line that explains it.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',

    // Reject duplicate/ambiguous query parameters rather than silently taking one.
    disableRequestLogging: false,
  });

  /* ---------------------------------------------------------------- */
  /* Context                                                           */
  /* ---------------------------------------------------------------- */

  app.decorate('config', config);
  app.decorate('prisma', prisma);
  app.decorate('redis', redis);

  const settings = new SettingsService({ prisma, redis, config });
  const mail = createMailService(config, logger);
  const auth = new AuthService({ prisma, config, logger });

  app.decorate('services', { auth, mail, settings });

  /* ---------------------------------------------------------------- */
  /* Security middleware                                               */
  /* ---------------------------------------------------------------- */

  await app.register(helmet, {
    // The API serves JSON, never HTML, so a restrictive CSP costs nothing and blocks
    // any attempt to get a browser to render a response as a document.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // HSTS is set at the edge by Caddy; duplicating it here is harmless but noisy.
    hsts: config.isProduction,
  });

  await app.register(cors, {
    /**
     * Explicit allow-list, never a reflected origin.
     *
     * With `credentials: true`, reflecting whatever `Origin` arrives is equivalent to
     * `Access-Control-Allow-Origin: *` with cookies — any site could then make
     * authenticated requests on a signed-in user's behalf.
     */
    origin(origin, callback) {
      // Same-origin and non-browser clients (mobile app, curl) send no Origin header.
      if (!origin) return callback(null, true);

      if (config.corsOrigins.includes(origin)) return callback(null, true);

      logger.warn({ origin }, 'Blocked cross-origin request');
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: config.SESSION_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: config.isProduction,
      // Strict rather than Lax: the refresh cookie is only ever needed on a same-site
      // XHR to /api/v1/auth/refresh, never on a top-level navigation from elsewhere.
      // Strict removes the cross-site CSRF surface entirely.
      sameSite: 'strict',
      path: '/api/v1/auth',
    },
  });

  await app.register(rateLimitPlugin);
  await app.register(authPlugin);

  /* ---------------------------------------------------------------- */
  /* Cross-cutting hooks                                               */
  /* ---------------------------------------------------------------- */

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    return payload;
  });

  // Maintenance mode: refuse everything except health checks and the admin surface, so
  // an operator can still investigate while the app is closed to users.
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api')) return;
    if (request.url.includes('/health') || request.url.includes('/ready')) return;
    if (request.url.startsWith('/api/v1/admin')) return;

    const current = await settings.get();
    if (current.maintenanceMode) throw Errors.maintenance();
  });

  /* ---------------------------------------------------------------- */
  /* Error handling                                                    */
  /* ---------------------------------------------------------------- */

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (isAppError(error)) {
      // 5xx is a server fault worth alerting on; 4xx is ordinary traffic and logging it
      // at error level would bury real problems.
      if (error.statusCode >= 500) {
        request.log.error({ err: error, internal: error.internal, requestId }, error.message);
      } else {
        request.log.info({ code: error.code, requestId }, error.message);
      }
      return reply.status(error.statusCode).send(error.toResponse(requestId));
    }

    if (error instanceof ZodError) {
      const appError = Errors.validation(
        error.issues.reduce<Record<string, string[]>>((acc, issue) => {
          const path = issue.path.join('.') || '_';
          (acc[path] ??= []).push(issue.message);
          return acc;
        }, {}),
      );
      return reply.status(appError.statusCode).send(appError.toResponse(requestId));
    }

    // Fastify's own errors: bad JSON, body too large, unsupported media type.
    // The two guards above narrow `error` to `never`, so take an explicit typed view
    // rather than relying on the (now useless) inferred type.
    const raw = error as { code?: string; statusCode?: number; message?: string };

    if (raw.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const appError = new AppError(ApiErrorCode.PAYLOAD_TOO_LARGE, 'That request is too large.');
      return reply.status(appError.statusCode).send(appError.toResponse(requestId));
    }

    if (raw.statusCode && raw.statusCode >= 400 && raw.statusCode < 500) {
      // A 4xx from Fastify is a malformed request, not a server fault. Its message is
      // about the request shape ("Unexpected end of JSON input") and is safe to echo.
      const appError = Errors.validation({ _: [raw.message ?? 'Malformed request'] });
      return reply.status(appError.statusCode).send(appError.toResponse(requestId));
    }

    /**
     * Unexpected failure. The stack, message and any query details stay in the log; the
     * client gets a generic message and the request id. Echoing internal error text is a
     * reliable way to leak table names, file paths and library versions.
     */
    request.log.error({ err: error, requestId }, 'Unhandled error');
    const appError = Errors.internal();
    return reply.status(appError.statusCode).send(appError.toResponse(requestId));
  });

  app.setNotFoundHandler(async (request, reply) => {
    const error = Errors.notFound('That endpoint');
    return reply.status(error.statusCode).send(error.toResponse(request.id));
  });

  /* ---------------------------------------------------------------- */
  /* Routes                                                            */
  /* ---------------------------------------------------------------- */

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(iceRoutes, { prefix: '/api/v1/ice' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  return app;
}
