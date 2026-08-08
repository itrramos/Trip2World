import { z } from 'zod';

/**
 * Realtime service configuration.
 *
 * Shares the same secrets as the API — notably JWT_SECRET, which is what lets a socket be
 * authenticated from its access token without a round trip to the API on every connect.
 */

const PLACEHOLDERS = new Set(['CHANGE_ME', 'changeme', 'secret', '']);

const strongSecret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters — run \`pnpm secrets:generate\``)
    .refine((v) => !PLACEHOLDERS.has(v.trim()), `${name} is still a placeholder`);

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true'));

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([z.literal(''), schema])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : (v as z.infer<T>)));

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOST: z.string().default('0.0.0.0'),

  APP_URL: z.string().url(),
  ADMIN_URL: optional(z.string().url()),
  CORS_ALLOWED_ORIGINS: csv.default(''),
  TRUST_PROXY: booleanish.default(true),

  /** Socket.IO path. Must match the Caddy route and the client. */
  REALTIME_PATH: z.string().default('/rt'),

  /**
   * Identifies this node in presence records and match rows. Must be unique per replica —
   * two nodes sharing an id makes cross-node socket routing ambiguous.
   */
  REALTIME_NODE_ID: z.string().default('rt-1'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().default('t2w'),

  JWT_SECRET: strongSecret('JWT_SECRET'),
  IP_HASH_SALT: strongSecret('IP_HASH_SALT'),
  TURN_SECRET: strongSecret('TURN_SECRET'),

  TURN_DOMAIN: optional(z.string().min(1)),
  TURN_PORT: z.coerce.number().int().default(3478),
  TURN_TLS_PORT: z.coerce.number().int().default(5349),
  TURN_ENABLE_TCP: booleanish.default(true),
  TURN_ENABLE_TLS: booleanish.default(false),
  USE_PUBLIC_STUN_FALLBACK: booleanish.default(false),
});

export type RealtimeConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  corsOrigins: string[];
  turnConfigured: boolean;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.stderr.write(
      `\nTrip2World realtime cannot start — invalid configuration:\n\n${lines.join('\n')}\n\n`,
    );
    process.exit(1);
  }

  const env = result.data;

  if (env.NODE_ENV === 'production' && !env.TURN_DOMAIN) {
    process.stderr.write(
      '\nTrip2World realtime cannot start: TURN_DOMAIN is required in production.\n' +
        'Without a relay, users behind symmetric NAT can never establish a call.\n\n',
    );
    process.exit(1);
  }

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    corsOrigins: [
      ...new Set([env.APP_URL, ...(env.ADMIN_URL ? [env.ADMIN_URL] : []), ...env.CORS_ALLOWED_ORIGINS]),
    ],
    turnConfigured: Boolean(env.TURN_DOMAIN) && env.TURN_SECRET.length >= 32,
  };
}
