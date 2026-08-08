import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Parsed once at boot and validated hard: a misconfigured service must fail loudly on
 * startup rather than at 3am on the first password reset. In particular this refuses to
 * start on a placeholder secret, because a deployment that silently runs with
 * `JWT_SECRET=CHANGE_ME` is fully compromised and looks completely healthy.
 */

const PLACEHOLDER_VALUES = new Set(['CHANGE_ME', 'changeme', 'secret', 'password', '']);

/**
 * A secret that must be real. The length floor is what makes an HS256 signature or an
 * HMAC actually expensive to forge; the placeholder check catches the far more common
 * failure of copying `.env.example` and never running the generator.
 */
const strongSecret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters — run \`pnpm secrets:generate\``)
    .refine(
      (v) => !PLACEHOLDER_VALUES.has(v.trim()),
      `${name} is still set to a placeholder — run \`pnpm secrets:generate\``,
    );

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true'));

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * An optional value that may legitimately arrive as an empty string.
 *
 * Docker Compose renders an unset variable as `""` (`TURN_DOMAIN: ${TURN_DOMAIN:-}`),
 * not as an absent key. Plain `.optional()` only permits `undefined`, so without this
 * every unset optional would fail validation and the service would refuse to boot on an
 * ordinary deployment.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([z.literal(''), schema])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : (v as z.infer<T>)));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),

    APP_URL: z.string().url(),
    APP_DOMAIN: z.string().min(1),
    ADMIN_URL: optional(z.string().url()),
    ADMIN_DOMAIN: optional(z.string().min(1)),
    CORS_ALLOWED_ORIGINS: csv.default(''),

    /** Behind Cloudflare or a tunnel this must be true, or every request appears to
     *  come from the proxy and rate limiting becomes global rather than per-client. */
    TRUST_PROXY: booleanish.default(true),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    REDIS_PREFIX: z.string().default('t2w'),

    JWT_SECRET: strongSecret('JWT_SECRET'),
    SESSION_SECRET: strongSecret('SESSION_SECRET'),
    IP_HASH_SALT: strongSecret('IP_HASH_SALT'),
    TURN_SECRET: strongSecret('TURN_SECRET'),

    TURN_DOMAIN: optional(z.string().min(1)),
    TURN_PORT: z.coerce.number().int().default(3478),
    TURN_TLS_PORT: z.coerce.number().int().default(5349),
    TURN_ENABLE_TCP: booleanish.default(true),
    TURN_ENABLE_TLS: booleanish.default(false),
    USE_PUBLIC_STUN_FALLBACK: booleanish.default(false),

    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_SECURE: booleanish.default(false),
    MAIL_FROM: z.string().default('Trip2World <noreply@localhost>'),
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),

    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    APPLE_CLIENT_ID: z.string().default(''),
    APPLE_TEAM_ID: z.string().default(''),
    APPLE_KEY_ID: z.string().default(''),
    APPLE_PRIVATE_KEY: z.string().default(''),

    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),

    MINIMUM_AGE: z.coerce.number().int().min(18).default(18),
    REGISTRATION_OPEN: booleanish.default(true),
    REQUIRE_EMAIL_VERIFICATION: booleanish.default(true),
    GUEST_ACCESS_ENABLED: booleanish.default(false),
    MAINTENANCE_MODE: booleanish.default(false),

    /** Expose /docs. Off in production by default — the schema is a map of the
     *  entire attack surface and there is no reason to publish it. */
    ENABLE_API_DOCS: booleanish.default(false),
  })
  .superRefine((env, ctx) => {
    // Distinct secrets. Reusing one key across purposes means a leak in any one
    // context (say a signed cookie) also forges access tokens.
    const secrets = {
      JWT_SECRET: env.JWT_SECRET,
      SESSION_SECRET: env.SESSION_SECRET,
      IP_HASH_SALT: env.IP_HASH_SALT,
      TURN_SECRET: env.TURN_SECRET,
    };
    const seen = new Map<string, string>();
    for (const [name, value] of Object.entries(secrets)) {
      const previous = seen.get(value);
      if (previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must differ from ${previous}. Reusing one secret across purposes means a leak anywhere forges everything.`,
        });
      }
      seen.set(value, name);
    }

    if (env.NODE_ENV === 'production') {
      if (!env.APP_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message:
            'APP_URL must be https:// in production. Secure cookies are refused over plain HTTP, which breaks login in a way that looks like a server bug.',
        });
      }

      if (env.MAIL_TRANSPORT === 'log') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_TRANSPORT'],
          message:
            'MAIL_TRANSPORT=log in production means nobody receives a password reset. Configure SMTP.',
        });
      }

      if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST is required in production for verification and password reset.',
        });
      }

      if (!env.TURN_DOMAIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TURN_DOMAIN'],
          message:
            'TURN_DOMAIN is required in production. Without a relay, users behind symmetric NAT can never connect.',
        });
      }

      if (env.ENABLE_API_DOCS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENABLE_API_DOCS'],
          message: 'Refusing to publish API documentation in production.',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  corsOrigins: string[];
  smtpConfigured: boolean;
  googleOAuthConfigured: boolean;
  appleOAuthConfigured: boolean;
  stripeConfigured: boolean;
  turnConfigured: boolean;
};

/**
 * Parse and validate `process.env`.
 *
 * On failure it prints every problem at once and exits non-zero. Reporting them one at a
 * time turns first-time setup into a guessing game.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  - ${key}: ${issue.message}`;
    });
    process.stderr.write(
      `\nTrip2World API cannot start — invalid configuration:\n\n${lines.join('\n')}\n\n` +
        'See .env.example for documentation of every variable.\n\n',
    );
    process.exit(1);
  }

  const env = result.data;

  // Always allow the app's own origins, plus anything explicitly listed.
  const corsOrigins = [
    ...new Set([env.APP_URL, ...(env.ADMIN_URL ? [env.ADMIN_URL] : []), ...env.CORS_ALLOWED_ORIGINS]),
  ];

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    corsOrigins,
    smtpConfigured: env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST.length > 0,
    googleOAuthConfigured: env.GOOGLE_CLIENT_ID.length > 0 && env.GOOGLE_CLIENT_SECRET.length > 0,
    appleOAuthConfigured: env.APPLE_CLIENT_ID.length > 0 && env.APPLE_PRIVATE_KEY.length > 0,
    stripeConfigured: env.STRIPE_SECRET_KEY.length > 0,
    turnConfigured: Boolean(env.TURN_DOMAIN) && env.TURN_SECRET.length >= 32,
  };
}
