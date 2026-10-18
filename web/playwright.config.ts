import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration.
 *
 * - CI: chromium-only, headed off, uploads artifacts on failure.
 * - Local dev: all browsers, headed mode available via `--headed` flag.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',

  /* Maximum time (ms) for a single test to run. */
  timeout: 30_000,

  /* Maximum time (ms) to wait for expect() assertions. */
  expect: {
    timeout: 5_000,
  },

  /* Run tests in files in parallel. */
  fullyParallel: true,

  /* Fail the build on CI if test.only() is accidentally committed. */
  forbidOnly: !!process.env['CI'],

  /* Retry failed tests once on CI, no retries locally. */
  retries: process.env['CI'] ? 1 : 0,

  /* Limit parallel workers on CI to avoid resource contention. */
  workers: process.env['CI'] ? 2 : undefined,

  /* Reporter: show dot-style summary in CI; HTML report for local dev. */
  reporter: process.env['CI']
    ? [['dot'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['html', { open: 'on-failure', outputFolder: 'playwright-report' }]],

  use: {
    /* Base URL for all page.goto() calls that use relative paths. */
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? `http://localhost:${process.env['FRONTEND_PORT'] ?? '3000'}`,

    /* Capture trace on first retry to aid debugging. */
    trace: 'on-first-retry',

    /* Record video on first retry. */
    video: 'on-first-retry',

    /* Take a screenshot only on test failure. */
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      /* CI: chromium only, headed off — the only project that runs in GitHub Actions. */
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    /* Local-dev-only projects (skipped when CI=true). */
    ...(!process.env['CI']
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
          },
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],

  /* Output directory for screenshots, videos, and traces. */
  outputDir: 'test-results',
});
