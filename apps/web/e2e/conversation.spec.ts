import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The acceptance test for the whole product: two people meet, talk, and one presses Next.
 *
 * Requires the full stack (api, realtime, postgres, redis) and is tagged @full so it is
 * skipped rather than failing noisily when only the web app is running.
 *
 * Two separate browser CONTEXTS, not two tabs. A tab shares cookies and therefore the
 * session, and matchmaking correctly refuses to pair a user with themselves — which is
 * exactly the confusion that cost an afternoon during development.
 */

const PASSWORD = 'an-entirely-adequate-passphrase';

function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Register and sign in a fresh account inside its own context. */
async function signUp(context: BrowserContext, prefix: string): Promise<{ page: Page; username: string }> {
  const page = await context.newPage();
  const username = unique(prefix).slice(0, 20);

  await page.goto('/register');

  await page.getByLabel('Email').fill(`${username}@e2e.test`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByLabel('Date of birth').fill('1995-04-12');
  await page.getByLabel('Country').selectOption('PT');
  await page.getByRole('checkbox').check();

  await page.getByRole('button', { name: /create account/i }).click();

  // With verification enforced the flow stops at "check your email"; without it, it signs
  // straight in. Handle both so the test does not depend on deployment configuration.
  await page.waitForLoadState('networkidle');

  if (await page.getByText(/check your email/i).isVisible().catch(() => false)) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(`${username}@e2e.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
  }

  await page.waitForURL(/\/discover/, { timeout: 20_000 });
  return { page, username };
}

/** Grant permissions, press Start, and wait until the client reports it is queued. */
async function startSearching(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start exploring/i }).click();
  // The searching stage shows either a hint or the "nobody else" copy.
  await expect(page.getByText(/searching|nobody else|connecting to trip2world/i)).toBeVisible({
    timeout: 20_000,
  });
}

/** Wait for a live peer connection: the partner chip appears once a match is announced. */
async function waitForMatch(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^next$/i })).toBeEnabled({ timeout: 45_000 });
}

test.describe('two people meet @full', () => {
  test('match, converse, and Next tears down and re-queues', async ({ browser }) => {
    const contextA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const contextB = await browser.newContext({ permissions: ['camera', 'microphone'] });

    try {
      const alice = await signUp(contextA, 'alice');
      const bob = await signUp(contextB, 'bob');

      await startSearching(alice.page);
      await startSearching(bob.page);

      // Both must land in a call. If only one does, the pairing was one-sided — a bug
      // that a single-browser test would never surface.
      await Promise.all([waitForMatch(alice.page), waitForMatch(bob.page)]);

      // The partner's name is rendered from the privacy-filtered profile.
      await expect(alice.page.getByText(bob.username, { exact: false })).toBeVisible({
        timeout: 15_000,
      });

      // Media actually flowing: the remote element gets a stream and starts playing.
      const remotePlaying = await alice.page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        return videos.some((v) => v.srcObject !== null && v.readyState >= 2);
      });
      expect(remotePlaying).toBe(true);

      // Press Next on one side.
      await alice.page.getByRole('button', { name: /^next$/i }).click();

      // The other side must be told, not left staring at a frozen frame.
      await expect(
        bob.page.getByText(/partner left|searching|nobody else/i),
      ).toBeVisible({ timeout: 20_000 });

      // And the presser goes straight back to searching.
      await expect(
        alice.page.getByText(/searching|nobody else|almost there/i),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('safety controls stay reachable during a call', async ({ browser }) => {
    const contextA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const contextB = await browser.newContext({ permissions: ['camera', 'microphone'] });

    try {
      const alice = await signUp(contextA, 'safe1');
      const bob = await signUp(contextB, 'safe2');

      await startSearching(alice.page);
      await startSearching(bob.page);
      await Promise.all([waitForMatch(alice.page), waitForMatch(bob.page)]);

      // The three controls that must never be unavailable while in a conversation.
      for (const name of [/^next$/i, /report this person/i, /block this person/i]) {
        await expect(alice.page.getByRole('button', { name })).toBeEnabled();
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('reporting ends the call and reaches the moderation queue', async ({ browser }) => {
    const contextA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const contextB = await browser.newContext({ permissions: ['camera', 'microphone'] });

    try {
      const alice = await signUp(contextA, 'rep1');
      const bob = await signUp(contextB, 'rep2');

      await startSearching(alice.page);
      await startSearching(bob.page);
      await Promise.all([waitForMatch(alice.page), waitForMatch(bob.page)]);

      await alice.page.getByRole('button', { name: /report this person/i }).click();

      const dialog = alice.page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('radio').first().check();
      await dialog.getByRole('button', { name: /send report/i }).click();

      // The conversation ends for the reporter immediately.
      await expect(alice.page.getByRole('button', { name: /^next$/i })).toBeDisabled({
        timeout: 20_000,
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('blocking asks for confirmation before it is applied', async ({ browser }) => {
    const contextA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const contextB = await browser.newContext({ permissions: ['camera', 'microphone'] });

    try {
      const alice = await signUp(contextA, 'blk1');
      const bob = await signUp(contextB, 'blk2');

      await startSearching(alice.page);
      await startSearching(bob.page);
      await Promise.all([waitForMatch(alice.page), waitForMatch(bob.page)]);

      await alice.page.getByRole('button', { name: /block this person/i }).click();

      // Blocking is permanent and mutual, so it must not happen on a single tap.
      const confirm = alice.page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(/never be matched/i);

      await confirm.getByRole('button', { name: /^block$/i }).click();
      await expect(confirm).toBeHidden({ timeout: 10_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe('signed-in navigation @full', () => {
  test('settings and tokens are reachable from Discover', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });

    try {
      const { page } = await signUp(context, 'nav');

      // This is the regression guard for the orphaned-settings bug: the links must exist
      // on the page a signed-in user actually lands on.
      await page.getByRole('link', { name: /settings/i }).first().click();
      await page.waitForURL(/\/settings/);
      await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();

      // Every tab must render without error.
      for (const tab of ['Profile', 'Privacy', 'Matching', 'Blocked', 'Account']) {
        await page.getByRole('button', { name: tab }).click();
        await expect(page.getByRole('button', { name: tab })).toHaveAttribute(
          'aria-current',
          'page',
        );
      }

      await page.getByRole('link', { name: /tokens/i }).first().click();
      await page.waitForURL(/\/settings\/tokens/);
      await expect(page.getByText(/your balance/i)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
