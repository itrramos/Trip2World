import { createHmac } from 'node:crypto';
import { TURN_CREDENTIAL_TTL_SECONDS } from '@trip2world/shared';
import type { IceServerConfig } from '@trip2world/types';

/**
 * Ephemeral TURN credentials (coturn REST authentication).
 *
 * A static TURN username and password shipped to the browser is a free, unmetered relay
 * for anyone who opens devtools — and relay bandwidth is the single most expensive thing
 * in this stack. coturn's `use-auth-secret` mode solves it: the server and coturn share a
 * secret that never reaches a client, and per-session credentials are *derived* rather
 * than stored.
 *
 *   username   = "<unix-expiry>:<userId>"
 *   credential = base64( HMAC-SHA1( secret, username ) )
 *
 * coturn recomputes the same HMAC on connect and rejects the credential once the embedded
 * timestamp has passed. Nothing is provisioned, nothing needs revoking, and a leaked
 * credential is useless within the TTL.
 *
 * HMAC-SHA1 is not a free choice here — it is what the coturn REST API specifies
 * (draft-uberti-behave-turn-rest-00). It is used as a MAC with a high-entropy key, which
 * is not affected by SHA-1's collision weaknesses.
 */

export interface TurnConfig {
  /** Shared secret, identical to coturn's `static-auth-secret`. */
  secret: string;
  /** Public hostname clients dial, e.g. `turn.trip2world.net`. */
  host: string;
  port?: number;
  tlsPort?: number;
  /** Public STUN endpoints used alongside TURN. */
  stunUrls?: string[];
  ttlSeconds?: number;
  /** Offer TURN over TCP/TLS as well as UDP. */
  enableTcp?: boolean;
  enableTls?: boolean;
}

export interface TurnCredential {
  username: string;
  credential: string;
  expiresAt: Date;
}

export function createTurnCredential(userId: string, config: TurnConfig): TurnCredential {
  if (!config.secret || config.secret.length < 32) {
    throw new Error('TURN_SECRET must be at least 32 characters. Generate one with `pnpm secrets:generate`.');
  }

  const ttl = config.ttlSeconds ?? TURN_CREDENTIAL_TTL_SECONDS;
  const expiryUnix = Math.floor(Date.now() / 1000) + ttl;

  // The user id is embedded so coturn's logs attribute relay usage to an account, which
  // is what makes per-user TURN abuse detectable at all.
  const username = `${expiryUnix}:${userId}`;
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');

  return { username, credential, expiresAt: new Date(expiryUnix * 1000) };
}

/**
 * Build the full `iceServers` array handed to `RTCPeerConnection`.
 *
 * Order matters: STUN first so a direct path is tried before falling back to a relay.
 * TURN over UDP is preferred, then TCP/TLS on 443 for networks that block UDP entirely —
 * which is the common case on corporate and some mobile networks, and the reason a
 * STUN-only deployment silently fails for a slice of users.
 */
export function buildIceServers(userId: string, config: TurnConfig): IceServerConfig[] {
  const servers: IceServerConfig[] = [];

  const stunUrls = config.stunUrls ?? [`stun:${config.host}:${config.port ?? 3478}`];
  if (stunUrls.length > 0) servers.push({ urls: stunUrls });

  const { username, credential } = createTurnCredential(userId, config);
  const port = config.port ?? 3478;

  const turnUrls: string[] = [`turn:${config.host}:${port}?transport=udp`];
  if (config.enableTcp !== false) turnUrls.push(`turn:${config.host}:${port}?transport=tcp`);
  if (config.enableTls && config.tlsPort) {
    turnUrls.push(`turns:${config.host}:${config.tlsPort}?transport=tcp`);
  }

  servers.push({ urls: turnUrls, username, credential });

  return servers;
}

/**
 * Public STUN fallbacks.
 *
 * Usable for local development only. Relying on them in production means depending on a
 * third party for a core function, leaking every user's IP to that third party, and still
 * having no relay for symmetric-NAT users — which is why `buildIceServers` never adds
 * them automatically.
 */
export const PUBLIC_STUN_FALLBACKS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];
