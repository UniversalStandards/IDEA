import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mocks the POST /api/user/api-keys endpoint to simulate key creation.
 */
async function mockCreateApiKey(page: Page, succeed: boolean): Promise<void> {
  await page.route('**/api/user/api-keys', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (succeed) {
      const body = route.request().postDataJSON() as { label?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `key-${Date.now()}`,
          label: body.label ?? 'Unnamed key',
          prefix: 'idea_sk_',
          secret: 'idea_sk_abc123xyz456_this_is_the_full_secret_only_shown_once',
          createdAt: new Date().toISOString(),
        }),
      });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not create API key' }),
      });
    }
  });
}

/**
 * Mocks the GET /api/user/usage endpoint.
 */
async function mockUsageStats(page: Page): Promise<void> {
  await page.route('**/api/user/usage', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        totalRequests: 1240,
        successfulRequests: 1198,
        failedRequests: 42,
        totalCostUsd: 3.57,
      }),
    });
  });
}

/**
 * Mocks the PATCH /api/user/profile endpoint.
 */
async function mockUpdateProfile(page: Page, succeed: boolean): Promise<void> {
  await page.route('**/api/user/profile', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    if (succeed) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not save settings' }),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// User-portal test suite
// ---------------------------------------------------------------------------

test.describe('User portal', () => {
  // ── API key creation ──────────────────────────────────────────────────────

  test('User can create an API key', async ({ page }) => {
    await mockCreateApiKey(page, true);
    await page.goto('/portal/api-keys');

    await expect(page.getByRole('heading', { name: 'API Keys', exact: true })).toBeVisible();

    // Fill in the key label and submit.
    await page.getByLabel('Key label').fill('My integration key');
    await page.getByRole('button', { name: 'Create API key' }).click();

    // The full secret should be shown exactly once after creation.
    await expect(page.getByRole('status', { name: 'New API key created' })).toBeVisible();
    await expect(page.getByTestId('new-api-key-value')).toBeVisible();

    // The key text should start with the expected prefix.
    const secretText = await page.getByTestId('new-api-key-value').textContent();
    expect(secretText).toContain('idea_sk_');

    // The new key should appear in the keys list.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'My integration key' }),
    ).toBeVisible();
  });

  // ── Usage statistics ──────────────────────────────────────────────────────

  test('User can view usage stats', async ({ page }) => {
    await mockUsageStats(page);

    // The usage page renders stats from static data on the server (no fetch in
    // this minimal implementation). We simply verify the key metrics are visible.
    await page.goto('/portal/usage');

    await expect(page.getByRole('heading', { name: 'Usage Statistics' })).toBeVisible();

    // Verify the summary section is present.
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();

    // Verify all metric labels are displayed.
    await expect(page.getByText('Total requests')).toBeVisible();
    await expect(page.getByText('Successful requests')).toBeVisible();
    await expect(page.getByText('Failed requests')).toBeVisible();
    await expect(page.getByText('Total cost (USD)')).toBeVisible();
  });

  // ── Profile settings ──────────────────────────────────────────────────────

  test('User can update profile settings', async ({ page }) => {
    await mockUpdateProfile(page, true);
    await page.goto('/portal/settings');

    await expect(page.getByRole('heading', { name: 'Profile Settings' })).toBeVisible();

    // Update the display name and email.
    await page.getByLabel('Display name').fill('Jane Doe');
    await page.getByLabel('Email address').fill('jane.doe@example.com');

    await page.getByRole('button', { name: 'Save settings' }).click();

    // A success status message should appear.
    await expect(
      page.getByRole('status').filter({ hasText: 'Settings saved successfully' }),
    ).toBeVisible();
  });
});
