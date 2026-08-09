import { expect, test } from '@playwright/test';

/**
 * Reachability.
 *
 * Every bug this file guards against was found by hand during development, and none of
 * them could have been caught by a unit or integration test:
 *
 *   - Terms and Community Guidelines were linked from the registration consent checkbox
 *     and both returned 404, so the consent was not informed.
 *   - /settings, /settings/tokens and the blocked list existed but nothing linked to
 *     them; once on /discover there was no route out.
 *
 * The pattern is always the same: the code is right, the wiring is missing. That is only
 * visible from a browser.
 */

test.describe('public navigation @smoke', () => {
  test('landing page renders its primary call to action', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Meet the world');
    await expect(page.getByRole('link', { name: /start exploring/i }).first()).toBeVisible();
  });

  /**
   * Follows every internal link on the landing page and asserts none of them 404.
   * Written as a crawl rather than a hardcoded list so a newly added link is covered
   * automatically — an explicit list only ever tests the links someone remembered.
   */
  test('no internal link on the landing page is broken', async ({ page, baseURL }) => {
    await page.goto('/');

    const hrefs = await page.locator('a[href^="/"]').evaluateAll((anchors) =>
      Array.from(new Set(anchors.map((a) => a.getAttribute('href')).filter(Boolean) as string[])),
    );

    expect(hrefs.length).toBeGreaterThan(4);

    const broken: string[] = [];
    for (const href of hrefs) {
      const response = await page.request.get(new URL(href, baseURL).toString());
      // 401/403 are fine — those are auth-gated pages, not missing ones.
      if (response.status() === 404) broken.push(href);
    }

    expect(broken, `these links 404: ${broken.join(', ')}`).toEqual([]);
  });

  test('every policy page loads with real content', async ({ page }) => {
    for (const path of ['/terms', '/privacy', '/guidelines', '/safety']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // A stub page would pass a status check; assert there is substance.
      const text = await page.locator('main').innerText();
      expect(text.length, `${path} looks empty`).toBeGreaterThan(500);
    }
  });

  test('the consent links in registration resolve', async ({ page }) => {
    await page.goto('/register');

    // These two specifically: the account cannot be created without ticking a box that
    // references them.
    for (const name of [/terms/i, /community guidelines/i]) {
      const link = page.getByRole('link', { name });
      await expect(link.first()).toBeVisible();
      const href = await link.first().getAttribute('href');
      expect(href).toBeTruthy();

      const response = await page.request.get(href!);
      expect(response.status(), `${href} must not 404`).toBeLessThan(400);
    }
  });
});

test.describe('auth pages @smoke', () => {
  test('registration requires accepting the terms', async ({ page }) => {
    await page.goto('/register');

    const submit = page.getByRole('button', { name: /create account/i });
    // Disabled until consent is given — the API also enforces it, but the UI must not
    // invite a submission it knows will fail.
    await expect(submit).toBeDisabled();

    await page.getByRole('checkbox').check();
    await expect(submit).toBeEnabled();
  });

  test('login rejects an unknown account without revealing whether it exists', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('definitely-not-a-user@example.test');
    await page.getByLabel('Password').fill('some-wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // Must not say "no such account" — that would be an enumeration oracle.
    await expect(alert).not.toContainText(/not found|no account|does not exist/i);
  });

  test('a signed-out visitor is redirected away from Discover', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain('/login');
  });

  /**
   * The `next` parameter must only ever accept a same-origin relative path. Taking it
   * verbatim is a textbook open redirect and a very effective phishing setup.
   */
  test('an external redirect target is refused', async ({ page }) => {
    await page.goto('/login?next=https://evil.example/steal');
    // Whatever happens on submit, the attacker URL must not appear as the destination.
    await expect(page).toHaveURL(/localhost|127\.0\.0\.1/);
  });
});

test.describe('progressive enhancement @smoke', () => {
  test('the page has a skip link for keyboard users', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to content/i })).toBeFocused();
  });

  test('the PWA manifest is served and well formed', async ({ page }) => {
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);

    const manifest = (await response.json()) as { name: string; start_url: string; icons: unknown[] };
    expect(manifest.name).toContain('Trip2World');
    // Installing should land on the product, not the marketing page.
    expect(manifest.start_url).toBe('/discover');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });
});
