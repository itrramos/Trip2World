import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * These exist to catch the class of defect that unit and integration tests structurally
 * cannot see: a control that exists in code but was never rendered, a page nobody can
 * navigate to, a link that 404s. Both real bugs found by hand during development were of
 * exactly that shape.
 *
 * Two suites, because they have very different requirements:
 *
 *   @smoke  — needs only the web app. Navigation, dead links, form validation, the
 *             signed-out experience. Fast, and runs on every pull request.
 *   @full   — needs the entire stack (api, realtime, postgres, redis). Registration,
 *             matching, tipping, moderation.
 *
 * Run with:
 *   pnpm test:e2e                          # everything against BASE_URL
 *   pnpm test:e2e --grep @smoke            # web only
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** True when the API is expected to be up, enabling the @full suite. */
const hasBackend = process.env.E2E_FULL_STACK === '1';

export default defineConfig({
  testDir: './e2e',
  // A hung WebRTC negotiation should fail the test, not the run.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  fullyParallel: false,
  // A stray `test.only` committed to main would silently skip everything else.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Artefacts only for failures — traces for every passing test bury the useful one.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: [
            // Grant and satisfy getUserMedia without real hardware. Chromium generates a
            // synthetic video stream, which is enough to negotiate a genuine peer
            // connection between two contexts.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            // Deterministic pattern rather than random noise, so a frame comparison
            // would be stable if we ever add one.
            '--allow-file-access-from-files',
          ],
        },
      },
    },
    {
      name: 'mobile',
      grep: /@smoke/,
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],

  // Skip the whole @full suite unless the backend is actually running, rather than
  // producing a wall of connection failures that hide a real regression.
  grepInvert: hasBackend ? undefined : /@full/,

  // Only start a dev server when pointing at localhost; against a deployed URL this
  // would be wrong and would mask which build is under test.
  webServer: BASE_URL.includes('localhost')
    ? {
        command: 'pnpm dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
