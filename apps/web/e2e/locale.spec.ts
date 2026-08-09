import { expect, test } from '@playwright/test';

/**
 * Locale routing.
 *
 * The failure modes here are all invisible in an English-speaking development
 * environment, which is why they need a browser:
 *
 *   - A `<Link>` imported from `next/link` instead of `@/i18n/navigation` silently drops
 *     the locale prefix, bouncing a Portuguese user back to English mid-journey.
 *   - `lang` on `<html>` stays "en" for every visitor if the attribute is set in the root
 *     layout, which lies to every screen reader that is not reading English.
 *   - An unknown locale segment renders a page whose catalogue cannot resolve, printing
 *     raw keys.
 *   - The middleware matcher, if too greedy, rewrites `/icon.svg` to `/en/icon.svg` and
 *     404s an asset that exists.
 */

test.describe('locale routing @smoke', () => {
  test('English serves from the bare path, with no prefix', async ({ page }) => {
    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    // The URL must not have acquired an /en prefix — every existing bookmark, the PWA
    // manifest's start_url, and every verification email already sent depend on this.
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('a translated locale renders its own copy and marks the document language', async ({
    page,
  }) => {
    await page.goto('/pt');

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Conhece o mundo');
  });

  test('internal links keep the locale', async ({ page }) => {
    await page.goto('/pt');

    await page.getByRole('link', { name: /entrar/i }).first().click();
    await page.waitForURL(/\/pt\/login/);

    // Still Portuguese after a client-side navigation, not bounced back to English.
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Bem-vindo');
  });

  test('an untranslated locale routes and falls back to English rather than failing', async ({
    page,
  }) => {
    const response = await page.goto('/de');

    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    // German has no catalogue yet, so the copy is English — real words, not raw keys.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Meet the world');
    await expect(page.locator('body')).not.toContainText('landing.headline');
  });

  test('an unsupported locale segment is a 404, not a page of raw keys', async ({ page }) => {
    const response = await page.goto('/xx');
    expect(response?.status()).toBe(404);
  });

  test('static assets are not rewritten by the locale middleware', async ({ request }) => {
    for (const path of ['/icon.svg', '/manifest.webmanifest']) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be served, not locale-rewritten`).toBe(200);
    }
  });
});

/*
 * Not covered here: the language picker itself. It lives behind authentication in
 * /settings, so exercising it needs a seeded account and a running API — that belongs
 * with the @full specs, not the smoke set. The property it must hold (never offer a
 * language that would render as English) is enforced by `TRANSLATED_LOCALES` and checked
 * by `pnpm i18n:check`.
 */
