import { type PrismaClient } from '@prisma/client';
import {
  DEFAULT_MINIMUM_AGE,
  DEFAULT_RELAXATION_STAGES,
  MAX_QUEUE_SECONDS,
  MIN_SECONDS_BETWEEN_SKIPS,
  NEGOTIATION_TIMEOUT_MS,
  SKIP_COOLDOWN_SECONDS,
} from '@trip2world/shared';
import { LOCALES, type SystemSettings } from '@trip2world/types';
import { prisma as defaultClient } from './client.js';

/**
 * Operator-tunable settings.
 *
 * Stored as individual key/value rows so the admin panel can update one setting without
 * a read-modify-write race against another admin editing a different one. Defaults live
 * here rather than in the database, so a fresh deployment is fully functional before
 * anyone opens the admin panel and an unknown key falls back safely.
 */

export const SETTING_KEYS = {
  minimumAge: 'minimum_age',
  registrationOpen: 'registration_open',
  guestAccessEnabled: 'guest_access_enabled',
  maintenanceMode: 'maintenance_mode',
  requireEmailVerificationToMatch: 'require_email_verification_to_match',
  enabledCountries: 'enabled_countries',
  supportedLocales: 'supported_locales',
  matchmaking: 'matchmaking',
} as const;

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  minimumAge: DEFAULT_MINIMUM_AGE,
  registrationOpen: true,
  guestAccessEnabled: false,
  maintenanceMode: false,
  requireEmailVerificationToMatch: true,
  // null means "no allow-list" — every supported country may register.
  enabledCountries: null,
  supportedLocales: [...LOCALES],
  matchmaking: {
    relaxationStages: DEFAULT_RELAXATION_STAGES,
    maxQueueSeconds: MAX_QUEUE_SECONDS,
    skipCooldownSeconds: SKIP_COOLDOWN_SECONDS,
    minSecondsBetweenSkips: MIN_SECONDS_BETWEEN_SKIPS,
    negotiationTimeoutMs: NEGOTIATION_TIMEOUT_MS,
  },
};

/**
 * Load the effective settings: stored values layered over the defaults.
 *
 * Callers should read through the Redis-backed cache in the API rather than calling this
 * on every request — see `apps/api/src/services/settings.service.ts`.
 */
export async function loadSystemSettings(
  client: PrismaClient = defaultClient,
): Promise<SystemSettings> {
  const rows = await client.systemSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  /**
   * Read one setting, falling back to the compiled-in default.
   *
   * The stored value is untyped JSON, so it is asserted to `T` here. That is safe in
   * practice because every write goes through the admin schema in
   * `@trip2world/validation`, but it does mean a value edited directly in the database
   * can be the wrong shape — hence the explicit null/undefined guard.
   */
  const read = <T>(key: string, fallback: T): T => {
    const value = byKey.get(key);
    if (value === null || value === undefined) return fallback;
    return value as T;
  };

  const settings: SystemSettings = {
    minimumAge: read(SETTING_KEYS.minimumAge, DEFAULT_SYSTEM_SETTINGS.minimumAge),
    registrationOpen: read(SETTING_KEYS.registrationOpen, DEFAULT_SYSTEM_SETTINGS.registrationOpen),
    guestAccessEnabled: read(
      SETTING_KEYS.guestAccessEnabled,
      DEFAULT_SYSTEM_SETTINGS.guestAccessEnabled,
    ),
    maintenanceMode: read(SETTING_KEYS.maintenanceMode, DEFAULT_SYSTEM_SETTINGS.maintenanceMode),
    requireEmailVerificationToMatch: read(
      SETTING_KEYS.requireEmailVerificationToMatch,
      DEFAULT_SYSTEM_SETTINGS.requireEmailVerificationToMatch,
    ),
    enabledCountries: read(SETTING_KEYS.enabledCountries, DEFAULT_SYSTEM_SETTINGS.enabledCountries),
    supportedLocales: read(SETTING_KEYS.supportedLocales, DEFAULT_SYSTEM_SETTINGS.supportedLocales),
    matchmaking: read(SETTING_KEYS.matchmaking, DEFAULT_SYSTEM_SETTINGS.matchmaking),
  };

  // The configured minimum age may be raised above the legal floor but never below it.
  settings.minimumAge = Math.max(settings.minimumAge, DEFAULT_MINIMUM_AGE);

  return settings;
}

export async function setSystemSetting(
  key: string,
  value: unknown,
  updatedById: string | null,
  client: PrismaClient = defaultClient,
): Promise<void> {
  await client.systemSetting.upsert({
    where: { key },
    create: { key, value: value as never, updatedById },
    update: { value: value as never, updatedById },
  });
}
