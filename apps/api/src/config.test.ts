import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

/**
 * These tests pin the refusals, not the happy path. Every one of them corresponds to a
 * misconfiguration that would otherwise produce a service that boots, looks healthy, and
 * is quietly broken or insecure.
 */

const VALID = {
  NODE_ENV: 'production',
  APP_URL: 'https://trip2world.net',
  APP_DOMAIN: 'trip2world.net',
  ADMIN_URL: 'https://admin.trip2world.net',
  DATABASE_URL: 'postgresql://u:p@postgres:5432/db',
  REDIS_URL: 'redis://:p@redis:6379',
  JWT_SECRET: 'a'.repeat(48),
  SESSION_SECRET: 'b'.repeat(48),
  IP_HASH_SALT: 'c'.repeat(48),
  TURN_SECRET: 'd'.repeat(48),
  TURN_DOMAIN: 'turn.trip2world.net',
  SMTP_HOST: 'smtp.gmail.com',
  MAIL_TRANSPORT: 'smtp',
} satisfies NodeJS.ProcessEnv;

/** Everything loadConfig wrote to stderr during the current test. */
let stderrOutput: string[] = [];
let restoreSpies: (() => void)[] = [];

beforeEach(() => {
  stderrOutput = [];

  // loadConfig calls process.exit on failure; turn that into a throw so the test
  // survives to make assertions.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrOutput.push(String(chunk));
    return true;
  }) as never);

  restoreSpies = [() => exitSpy.mockRestore(), () => stderrSpy.mockRestore()];
});

afterEach(() => {
  for (const restore of restoreSpies) restore();
});

/** Run loadConfig, assert it bailed, and return what it reported. */
function expectRejection(env: NodeJS.ProcessEnv): string {
  expect(() => loadConfig(env)).toThrow('process.exit');
  return stderrOutput.join('\n');
}

describe('valid configuration', () => {
  it('loads and derives the capability flags', () => {
    const config = loadConfig(VALID);

    expect(config.isProduction).toBe(true);
    expect(config.smtpConfigured).toBe(true);
    expect(config.turnConfigured).toBe(true);
    // Optional integrations are absent, and the app must remain functional without them.
    expect(config.googleOAuthConfigured).toBe(false);
    expect(config.stripeConfigured).toBe(false);
  });

  it('always trusts its own origins for CORS, plus anything explicitly listed', () => {
    const config = loadConfig({
      ...VALID,
      CORS_ALLOWED_ORIGINS: 'https://trip2world.net,https://extra.example',
    });

    expect(config.corsOrigins).toContain('https://trip2world.net');
    expect(config.corsOrigins).toContain('https://admin.trip2world.net');
    expect(config.corsOrigins).toContain('https://extra.example');
    // Deduplicated despite the overlap with APP_URL.
    expect(new Set(config.corsOrigins).size).toBe(config.corsOrigins.length);
  });

  it('coerces string booleans from the environment', () => {
    expect(loadConfig({ ...VALID, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...VALID, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  /**
   * Docker Compose renders an unset variable as an empty string rather than omitting
   * it — `ADMIN_URL: ${ADMIN_URL:-}` produces `ADMIN_URL=""`. A plain `.optional()`
   * rejects that, so every unset optional would have blocked startup on a perfectly
   * ordinary deployment.
   */
  it('treats an empty string as "not set" for optional values', () => {
    const config = loadConfig({
      ...VALID,
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      MAIL_TRANSPORT: 'log',
      SMTP_HOST: '',
      ADMIN_URL: '',
      ADMIN_DOMAIN: '',
      TURN_DOMAIN: '',
      GOOGLE_CLIENT_ID: '',
      STRIPE_SECRET_KEY: '',
    });

    expect(config.ADMIN_URL).toBeUndefined();
    expect(config.TURN_DOMAIN).toBeUndefined();
    expect(config.turnConfigured).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
  });
});

describe('secret validation', () => {
  it('refuses to start on an unreplaced placeholder', () => {
    const output = expectRejection({ ...VALID, JWT_SECRET: 'CHANGE_ME' });
    expect(output).toMatch(/JWT_SECRET/);
    expect(output).toMatch(/secrets:generate/);
  });

  it('refuses a secret that is too short to be meaningful', () => {
    expect(expectRejection({ ...VALID, SESSION_SECRET: 'short' })).toMatch(/at least 32/);
  });

  it('refuses to reuse one secret across two purposes', () => {
    const shared = 'z'.repeat(48);
    const output = expectRejection({ ...VALID, JWT_SECRET: shared, SESSION_SECRET: shared });
    expect(output).toMatch(/must differ/);
  });

  it('reports every problem at once rather than one per run', () => {
    const output = expectRejection({
      ...VALID,
      JWT_SECRET: 'CHANGE_ME',
      SESSION_SECRET: 'CHANGE_ME',
      IP_HASH_SALT: 'short',
    });

    expect(output).toMatch(/JWT_SECRET/);
    expect(output).toMatch(/SESSION_SECRET/);
    expect(output).toMatch(/IP_HASH_SALT/);
  });
});

describe('production guards', () => {
  it('refuses plain HTTP, because secure cookies would silently be dropped', () => {
    expect(expectRejection({ ...VALID, APP_URL: 'http://trip2world.net' })).toMatch(
      /must be https/,
    );
  });

  it('allows plain HTTP in development', () => {
    const config = loadConfig({
      ...VALID,
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      MAIL_TRANSPORT: 'log',
      SMTP_HOST: '',
      TURN_DOMAIN: '',
    });
    expect(config.isDevelopment).toBe(true);
  });

  it('refuses to swallow mail in production', () => {
    expect(expectRejection({ ...VALID, MAIL_TRANSPORT: 'log' })).toMatch(/password reset/);
  });

  it('requires SMTP to be configured in production', () => {
    expect(expectRejection({ ...VALID, SMTP_HOST: '' })).toMatch(/SMTP_HOST is required/);
  });

  it('requires a TURN domain in production', () => {
    expect(expectRejection({ ...VALID, TURN_DOMAIN: '' })).toMatch(/symmetric NAT/);
  });

  it('refuses to publish API documentation in production', () => {
    expect(expectRejection({ ...VALID, ENABLE_API_DOCS: 'true' })).toMatch(/Refusing to publish/);
  });

  it('will not accept a minimum age below the legal floor', () => {
    expect(expectRejection({ ...VALID, MINIMUM_AGE: '16' })).toMatch(/MINIMUM_AGE/);
  });
});

describe('required infrastructure', () => {
  it('refuses to start without a database or redis URL', () => {
    expect(expectRejection({ ...VALID, DATABASE_URL: '' })).toMatch(/DATABASE_URL/);
    expect(expectRejection({ ...VALID, REDIS_URL: '' })).toMatch(/REDIS_URL/);
  });

  it('rejects a malformed APP_URL', () => {
    expect(expectRejection({ ...VALID, APP_URL: 'not a url' })).toMatch(/APP_URL/);
  });
});
