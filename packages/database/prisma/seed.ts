/**
 * Database seed: `pnpm db:seed`
 *
 * Two tiers, deliberately separated:
 *
 *   REFERENCE DATA (always seeded, idempotent) — interests, feature flags, and default
 *   system settings. A production deployment needs these to function.
 *
 *   DEVELOPMENT FIXTURES (opt-in) — sample users with known passwords, so two browsers
 *   can be matched against each other locally. These are gated behind an explicit
 *   `SEED_DEV_USERS=true` AND refused outright when NODE_ENV is production, because
 *   seeding accounts with published passwords onto a reachable server would be a
 *   critical vulnerability rather than a convenience.
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Kept in sync with INTEREST_CATALOGUE in @trip2world/shared. */
const INTERESTS = [
  { slug: 'travel', label: 'Travel', emoji: '✈️', sortOrder: 10 },
  { slug: 'gaming', label: 'Gaming', emoji: '🎮', sortOrder: 20 },
  { slug: 'music', label: 'Music', emoji: '🎧', sortOrder: 30 },
  { slug: 'movies', label: 'Movies', emoji: '🎬', sortOrder: 40 },
  { slug: 'technology', label: 'Technology', emoji: '💻', sortOrder: 50 },
  { slug: 'sports', label: 'Sports', emoji: '⚽', sortOrder: 60 },
  { slug: 'fitness', label: 'Fitness', emoji: '🏋️', sortOrder: 70 },
  { slug: 'photography', label: 'Photography', emoji: '📷', sortOrder: 80 },
  { slug: 'food', label: 'Food', emoji: '🍜', sortOrder: 90 },
  { slug: 'languages', label: 'Languages', emoji: '🗣️', sortOrder: 100 },
  { slug: 'books', label: 'Books', emoji: '📚', sortOrder: 110 },
  { slug: 'art', label: 'Art', emoji: '🎨', sortOrder: 120 },
  { slug: 'cars', label: 'Cars', emoji: '🚗', sortOrder: 130 },
  { slug: 'business', label: 'Business', emoji: '📈', sortOrder: 140 },
  { slug: 'science', label: 'Science', emoji: '🔬', sortOrder: 150 },
];

const FEATURE_FLAGS = [
  { key: 'text_chat', enabled: true, description: 'Ephemeral text chat during a match.' },
  { key: 'connections', enabled: true, description: 'Connection requests after a match.' },
  {
    key: 'priority_queue',
    enabled: false,
    description: 'Paid tiers are dequeued ahead of free users.',
  },
  {
    key: 'guest_mode',
    enabled: false,
    description: 'Allow matching without a registered account.',
  },
  { key: 'subscriptions', enabled: false, description: 'Show paid plans and billing UI.' },
];

async function seedInterests() {
  for (const interest of INTERESTS) {
    await prisma.interest.upsert({
      where: { slug: interest.slug },
      create: interest,
      // Labels and ordering are editable content; the slug is the stable key.
      update: { label: interest.label, emoji: interest.emoji, sortOrder: interest.sortOrder },
    });
  }
  process.stdout.write(`  interests:      ${INTERESTS.length} upserted\n`);
}

async function seedFeatureFlags() {
  for (const flag of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: { ...flag, rolloutPercentage: 100 },
      // Never overwrite an operator's toggle on re-seed — only fill in missing rows.
      update: { description: flag.description },
    });
  }
  process.stdout.write(`  feature flags:  ${FEATURE_FLAGS.length} ensured\n`);
}

/**
 * Token packages.
 *
 * Prices are in minor units (cents) so nothing ever touches a float. The larger packs
 * carry a better per-token rate, which is the standard shape and gives people a reason
 * to buy more than the minimum.
 *
 * Amounts here are a sensible starting point, not a recommendation — an operator should
 * set them from the admin panel to suit their market.
 */
const TOKEN_PACKAGES = [
  { slug: 'starter', tokens: 100, priceCents: 199, currency: 'EUR', label: null, sortOrder: 10 },
  { slug: 'popular', tokens: 550, priceCents: 999, currency: 'EUR', label: 'Most popular', sortOrder: 20 },
  { slug: 'plus', tokens: 1200, priceCents: 1999, currency: 'EUR', label: null, sortOrder: 30 },
  { slug: 'pro', tokens: 3200, priceCents: 4999, currency: 'EUR', label: 'Best value', sortOrder: 40 },
];

async function seedTokenPackages() {
  for (const pkg of TOKEN_PACKAGES) {
    await prisma.tokenPackage.upsert({
      where: { slug: pkg.slug },
      create: pkg,
      // Never overwrite pricing an operator has changed — only ensure the row exists.
      update: {},
    });
  }
  process.stdout.write(`  token packs:    ${TOKEN_PACKAGES.length} ensured\n`);
}

async function seedSystemSettings() {
  const defaults: { key: string; value: unknown; description: string }[] = [
    { key: 'minimum_age', value: 18, description: 'Minimum age required to register.' },
    { key: 'registration_open', value: true, description: 'Allow new registrations.' },
    { key: 'guest_access_enabled', value: false, description: 'Allow guest matchmaking.' },
    { key: 'maintenance_mode', value: false, description: 'Serve a maintenance page.' },
    {
      key: 'require_email_verification_to_match',
      value: true,
      description: 'Require a verified email before entering matchmaking.',
    },
  ];

  for (const setting of defaults) {
    const existing = await prisma.systemSetting.findUnique({ where: { key: setting.key } });
    if (existing) continue; // Operator's value wins.
    await prisma.systemSetting.create({
      data: {
        key: setting.key,
        value: setting.value as never,
        description: setting.description,
      },
    });
  }
  process.stdout.write(`  settings:       ${defaults.length} ensured\n`);
}

/**
 * Sample accounts for local development.
 *
 * The password is intentionally read from the environment with no default, so that even
 * when someone enables dev seeding they must choose the credential — there is no password
 * baked into this repository that would work against a deployed instance.
 */
async function seedDevUsers() {
  const password = process.env.SEED_USER_PASSWORD;
  if (!password) {
    process.stdout.write(
      '  dev users:      skipped (set SEED_USER_PASSWORD to create sample accounts)\n',
    );
    return;
  }
  if (password.length < 10) {
    throw new Error('SEED_USER_PASSWORD must be at least 10 characters.');
  }

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  const fixtures = [
    {
      email: 'ana@trip2world.test',
      username: 'ana_pt',
      displayName: 'Ana',
      country: 'PT',
      languages: ['pt', 'en'],
      gender: 'FEMALE' as const,
      locale: 'pt',
      birthDate: new Date('1996-03-15T00:00:00.000Z'),
      interests: ['travel', 'music', 'food'],
    },
    {
      email: 'lukas@trip2world.test',
      username: 'lukas_de',
      displayName: 'Lukas',
      country: 'DE',
      languages: ['de', 'en'],
      gender: 'MALE' as const,
      locale: 'de',
      birthDate: new Date('1994-07-02T00:00:00.000Z'),
      interests: ['travel', 'technology', 'music'],
    },
    {
      email: 'sofia@trip2world.test',
      username: 'sofia_br',
      displayName: 'Sofia',
      country: 'BR',
      languages: ['pt', 'es'],
      gender: 'FEMALE' as const,
      locale: 'pt',
      birthDate: new Date('2000-11-20T00:00:00.000Z'),
      interests: ['art', 'photography', 'books'],
    },
    {
      email: 'marco@trip2world.test',
      username: 'marco_it',
      displayName: 'Marco',
      country: 'IT',
      languages: ['it', 'en'],
      gender: 'MALE' as const,
      locale: 'it',
      birthDate: new Date('1990-01-08T00:00:00.000Z'),
      interests: ['food', 'sports', 'cars'],
    },
  ];

  for (const fixture of fixtures) {
    const interestRows = await prisma.interest.findMany({
      where: { slug: { in: fixture.interests } },
      select: { id: true },
    });

    await prisma.user.upsert({
      where: { email: fixture.email },
      update: {},
      create: {
        email: fixture.email,
        username: fixture.username,
        passwordHash,
        status: 'ACTIVE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        profile: {
          create: {
            displayName: fixture.displayName,
            birthDate: fixture.birthDate,
            gender: fixture.gender,
            country: fixture.country,
            languages: fixture.languages,
            locale: fixture.locale,
            bio: `Hi, I am ${fixture.displayName}. Let's talk!`,
          },
        },
        privacy: { create: {} },
        preference: { create: {} },
        interests: { create: interestRows.map((i) => ({ interestId: i.id })) },
      },
    });
  }

  process.stdout.write(`  dev users:      ${fixtures.length} ensured (password from env)\n`);
}

async function main() {
  process.stdout.write('\n  Seeding Trip2World\n  ------------------\n');

  await seedInterests();
  await seedFeatureFlags();
  await seedTokenPackages();
  await seedSystemSettings();

  const wantsDevUsers = process.env.SEED_DEV_USERS === 'true';
  const isProduction = process.env.NODE_ENV === 'production';

  if (wantsDevUsers && isProduction) {
    throw new Error(
      'Refusing to seed development users with NODE_ENV=production. ' +
        'Sample accounts must never exist on a reachable deployment.',
    );
  }

  if (wantsDevUsers) {
    await seedDevUsers();
  } else {
    process.stdout.write('  dev users:      skipped (set SEED_DEV_USERS=true to enable)\n');
  }

  process.stdout.write('\n  Done.\n\n');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`\n  x ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
