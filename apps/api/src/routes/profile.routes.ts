import {
  DEFAULT_PRIVACY_SETTINGS,
  MAX_INTERESTS_PER_USER,
  PREFERRED_COUNTRY_LIMIT,
  RATE_LIMITS,
  ageBracketFor,
  calculateAge,
} from '@trip2world/shared';
import type { PlanTier } from '@trip2world/types';
import {
  parseInput,
  updateInterestsSchema,
  updatePreferencesSchema,
  updatePrivacySchema,
  updateProfileSchema,
} from '@trip2world/validation';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError, Errors } from '../errors.js';

/**
 * The authenticated user's own profile, privacy, preferences and interests.
 *
 * Everything here is scoped to `request.user.id`. No route accepts a user id from the
 * client, which removes IDOR from this surface entirely rather than relying on each
 * handler to remember an ownership check.
 */
export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, requestId: string): z.infer<S> {
    const result = parseInput(schema, input, requestId);
    if (!result.success) {
      throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    }
    return result.data;
  }

  /** The shape every profile endpoint returns, so the client never has to refetch. */
  async function loadProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerified: true,
        plan: true,
        profile: true,
        privacy: true,
        preference: true,
        interests: { select: { interest: { select: { slug: true } } } },
      },
    });
    if (!user) throw Errors.notFound('Your account');

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      displayName: user.profile?.displayName ?? null,
      avatarUrl: user.profile?.avatarUrl ?? null,
      bio: user.profile?.bio ?? null,
      country: user.profile?.country ?? null,
      gender: user.profile?.gender ?? null,
      languages: user.profile?.languages ?? [],
      locale: user.profile?.locale ?? 'en',
      // The owner sees their exact age; partners only ever see the bracket.
      age: calculateAge(user.profile?.birthDate ?? null),
      ageBracket: ageBracketFor(user.profile?.birthDate ?? null),
      privacy: user.privacy
        ? { ...DEFAULT_PRIVACY_SETTINGS, ...user.privacy, fieldOverrides: {} }
        : DEFAULT_PRIVACY_SETTINGS,
      preferences: user.preference,
      interests: user.interests.map((i) => i.interest.slug),
    };
  }

  /* ------------------------------------------------------------------ */

  app.get('/', { onRequest: [app.authenticate] }, async (request, reply) =>
    reply.send({ ok: true, data: await loadProfile(request.user!.id) }),
  );

  app.patch(
    '/',
    { onRequest: [app.authenticate, app.rateLimit('profile-write', RATE_LIMITS.apiWrite)] },
    async (request, reply) => {
      const input = parse(updateProfileSchema, request.body, request.id);
      const userId = request.user!.id;

      await prisma.profile.update({
        where: { userId },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.gender !== undefined ? { gender: input.gender as never } : {}),
          ...(input.languages !== undefined ? { languages: input.languages } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        },
      });

      return reply.send({ ok: true, data: await loadProfile(userId) });
    },
  );

  app.patch('/privacy', { onRequest: [app.authenticate] }, async (request, reply) => {
    const input = parse(updatePrivacySchema, request.body, request.id);
    const userId = request.user!.id;

    await prisma.privacySetting.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });

    return reply.send({ ok: true, data: await loadProfile(userId) });
  });

  app.patch('/preferences', { onRequest: [app.authenticate] }, async (request, reply) => {
    const input = parse(updatePreferencesSchema, request.body, request.id);
    const user = request.user!;

    /**
     * Country-preference allowance is per plan, and the schema cannot enforce it because
     * a schema does not know who is asking. Checked here against the caller's actual
     * plan rather than trusting a client-side limit.
     */
    if (input.preferredCountries) {
      const limit = PREFERRED_COUNTRY_LIMIT[user.plan as PlanTier] ?? 1;
      if (input.preferredCountries.length > limit) {
        throw new AppError('VALIDATION_ERROR', 'Too many preferred countries for your plan.', {
          details: {
            preferredCountries: [
              `Your plan allows ${limit} preferred ${limit === 1 ? 'country' : 'countries'}.`,
            ],
          },
        });
      }
    }

    // The schema is `.strict()`, so every key present is a real Preference column.
    // Cast once at the boundary rather than sprinkling `as never` through the call.
    const data = input as Record<string, unknown>;

    await prisma.preference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data } as never,
      update: data as never,
    });

    return reply.send({ ok: true, data: await loadProfile(user.id) });
  });

  /** The interest catalogue. Public to any signed-in user. */
  app.get('/interests/catalogue', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const interests = await prisma.interest.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, label: true, emoji: true },
    });
    return reply.send({ ok: true, data: interests });
  });

  /**
   * Replace the user's interests wholesale.
   *
   * PUT rather than PATCH because the client always sends the complete set — a
   * chip-picker has no natural notion of a partial update, and delete-then-insert inside
   * one transaction avoids the diffing bugs that come with trying.
   */
  app.put('/interests', { onRequest: [app.authenticate] }, async (request, reply) => {
    const input = parse(updateInterestsSchema, request.body, request.id);
    const userId = request.user!.id;

    if (input.interests.length > MAX_INTERESTS_PER_USER) {
      throw Errors.validation({
        interests: [`Choose at most ${MAX_INTERESTS_PER_USER} interests.`],
      });
    }

    const rows = await prisma.interest.findMany({
      where: { slug: { in: input.interests }, active: true },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.userInterest.deleteMany({ where: { userId } }),
      prisma.userInterest.createMany({
        data: rows.map((row) => ({ userId, interestId: row.id })),
      }),
    ]);

    return reply.send({ ok: true, data: await loadProfile(userId) });
  });
}
