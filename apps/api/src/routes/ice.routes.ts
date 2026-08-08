import { buildIceServers, PUBLIC_STUN_FALLBACKS } from '@trip2world/auth';
import { TURN_CREDENTIAL_TTL_SECONDS } from '@trip2world/shared';
import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors.js';

/**
 * ICE server configuration.
 *
 * Authenticated on purpose. These credentials authorise relay bandwidth — the most
 * expensive resource in the stack — so an unauthenticated endpoint here would be an open
 * TURN server with extra steps, discoverable by anyone who reads the client bundle.
 *
 * The credentials are derived per user and expire in two hours; the shared secret never
 * leaves the server. See `packages/auth/src/turn.ts`.
 */
export async function iceRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app;

  app.get('/servers', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user!;

    if (!config.turnConfigured) {
      // Development convenience only. Public STUN gives no relay, so symmetric-NAT
      // users still will not connect — the production config validator refuses to let
      // a deployment reach this branch.
      if (config.USE_PUBLIC_STUN_FALLBACK && !config.isProduction) {
        request.log.warn('Serving public STUN fallback — no TURN relay available');
        return reply.send({
          ok: true,
          data: {
            iceServers: [{ urls: PUBLIC_STUN_FALLBACKS }],
            ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
            relayAvailable: false,
          },
        });
      }

      throw Errors.internal({ reason: 'TURN_NOT_CONFIGURED' });
    }

    const iceServers = buildIceServers(user.id, {
      secret: config.TURN_SECRET,
      host: config.TURN_DOMAIN!,
      port: config.TURN_PORT,
      tlsPort: config.TURN_TLS_PORT,
      enableTcp: config.TURN_ENABLE_TCP,
      enableTls: config.TURN_ENABLE_TLS,
      ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
    });

    // Short cache, private: the response contains a credential scoped to this user and
    // must never be stored by a shared cache or the CDN.
    reply.header('Cache-Control', 'private, max-age=300');

    return reply.send({
      ok: true,
      data: { iceServers, ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS, relayAvailable: true },
    });
  });
}
