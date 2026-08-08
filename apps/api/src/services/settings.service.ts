import type { PrismaClient } from '@prisma/client';
import { DEFAULT_SYSTEM_SETTINGS, loadSystemSettings } from '@trip2world/database';
import { REDIS_TTL } from '@trip2world/shared';
import type { SystemSettings } from '@trip2world/types';
import type { AppConfig } from '../config.js';
import type { RedisContext } from '../redis.js';
import { TIMEOUTS, withTimeoutOr } from '../utils/timeout.js';

/**
 * Runtime settings, read through a short Redis cache.
 *
 * Settings are consulted on nearly every request (maintenance mode, age gate,
 * registration open), so hitting Postgres each time would add a query to the hot path for
 * data that changes a few times a year. A 60-second TTL bounds staleness, and an explicit
 * invalidation on admin write makes a deliberate change take effect immediately.
 *
 * On a Redis or database failure the compiled-in defaults are returned rather than
 * throwing — a settings lookup must never be the reason the whole API is down.
 */
export class SettingsService {
  private memoryCache: { value: SystemSettings; expiresAt: number } | null = null;

  constructor(
    private readonly deps: { prisma: PrismaClient; redis: RedisContext; config: AppConfig },
  ) {}

  async get(): Promise<SystemSettings> {
    // A process-local cache in front of Redis. Settings are read several times per
    // request and a 1-second window removes almost all of that traffic.
    if (this.memoryCache && this.memoryCache.expiresAt > Date.now()) {
      return this.memoryCache.value;
    }

    const { redis, prisma, config } = this.deps;

    // Every external call here carries a deadline. This method runs on the hot path of
    // nearly every request (maintenance mode, age gate), so if Redis or Postgres becomes
    // unreachable it must degrade to defaults in milliseconds rather than hanging and
    // stalling the entire API behind a dead dependency.
    const cached = await withTimeoutOr<string | null>(
      redis.client.get(redis.keys.systemSettings()),
      TIMEOUTS.redis,
      null,
    );

    if (cached) {
      try {
        const value = JSON.parse(cached) as SystemSettings;
        this.memoryCache = { value, expiresAt: Date.now() + 1000 };
        return value;
      } catch {
        // Corrupt cache entry — fall through and re-read from the database.
      }
    }

    const value = this.applyEnvOverrides(
      await withTimeoutOr(
        loadSystemSettings(prisma),
        TIMEOUTS.settingsQuery,
        DEFAULT_SYSTEM_SETTINGS,
      ),
      config,
    );

    // Cache write is best-effort and time-boxed; failing to populate the cache must not
    // fail the request that triggered the read.
    await withTimeoutOr(
      redis.client.set(
        redis.keys.systemSettings(),
        JSON.stringify(value),
        'EX',
        REDIS_TTL.settings,
      ),
      TIMEOUTS.redis,
      null,
    );

    this.memoryCache = { value, expiresAt: Date.now() + 1000 };
    return value;
  }

  /** Drop both cache layers. Called after any admin settings write. */
  async invalidate(): Promise<void> {
    this.memoryCache = null;
    await this.deps.redis.client.del(this.deps.redis.keys.systemSettings()).catch(() => undefined);
  }

  private applyEnvOverrides(settings: SystemSettings, config: AppConfig): SystemSettings {
    return {
      ...settings,
      // The environment can only ever RAISE the age gate, never lower it.
      minimumAge: Math.max(settings.minimumAge, config.MINIMUM_AGE),
      maintenanceMode: settings.maintenanceMode || config.MAINTENANCE_MODE,
      registrationOpen: settings.registrationOpen && config.REGISTRATION_OPEN,
      requireEmailVerificationToMatch:
        settings.requireEmailVerificationToMatch && config.REQUIRE_EMAIL_VERIFICATION,
      guestAccessEnabled: settings.guestAccessEnabled && config.GUEST_ACCESS_ENABLED,
    };
  }
}
