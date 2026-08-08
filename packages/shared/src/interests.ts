/**
 * Canonical interest catalogue.
 *
 * Seeded into Postgres by `pnpm db:seed` and used by the UI for the picker. Slugs are the
 * i18n lookup keys (`interest.travel`), so renaming a label never breaks translations.
 */

export interface InterestSeed {
  slug: string;
  label: string;
  emoji: string;
  sortOrder: number;
}

export const INTEREST_CATALOGUE: readonly InterestSeed[] = [
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

export const INTEREST_SLUGS: readonly string[] = INTEREST_CATALOGUE.map((i) => i.slug);

export function isKnownInterestSlug(slug: string): boolean {
  return INTEREST_SLUGS.includes(slug);
}
