import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mocks the POST /api/auth/login endpoint.
 *
 * @param page     - Playwright page object.
 * @param succeed  - When true, returns HTTP 200 with a session token; when false, returns HTTP 401.
 * @param email    - Optional: only intercept requests for this specific email.
 */
async function mockLogin(
  page: Page,
  succeed: boolean,
  email?: string,
): Promise<void> {
  await page.route('**/api/auth/login', async (route) => {
    const body = route.request().postDataJSON() as { email?: string };
    if (email !== undefined && body.email !== email) {
      await route.continue();
      return;
    }
    if (succeed) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'mock-session-token' }),
      });
    } else {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid email or password' }),
      });
    }
  });
}

/**
 * Mocks the POST /api/auth/register endpoint.
 *
 * @param page    - Playwright page object.
 * @param succeed - When true returns 201; when false returns 409 (duplicate email).
 */
async function mockRegister(page: Page, succeed: boolean): Promise<void> {
  await page.route('**/api/auth/register', async (route) => {
    if (succeed) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-user-id' }),
      });
    } else {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'An account with that email already exists' }),
      });
    }
  });
}

/**
 * Mocks the POST /api/auth/forgot-password endpoint.
 */
async function mockForgotPassword(page: Page): Promise<void> {
  await page.route('**/api/auth/forgot-password', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

/**
 * Mocks the 2FA QR image and enrollment endpoints.
 */
async function mock2FA(page: Page, enrollSucceed: boolean): Promise<void> {
  // Stub the QR-code image so the test doesn't need a real backend.
  await page.route('**/api/auth/2fa/qr', async (route) => {
    // Return a tiny 1x1 transparent PNG.
    const transparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng });
  });

  await page.route('**/api/auth/2fa/enroll', async (route) => {
    if (enrollSucceed) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid TOTP code' }),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Auth test suite
// ---------------------------------------------------------------------------

test.describe('Auth flows', () => {
  // ── Registration ──────────────────────────────────────────────────────────

  test('User can register with valid email and password', async ({ page }) => {
    await mockRegister(page, true);
    await page.goto('/auth/register');

    await page.getByLabel('Email address').fill('newuser@example.com');
    await page.getByLabel('Password').fill('Str0ng!Pass99');
    await page.getByRole('button', { name: 'Create account' }).click();

    // After successful registration the success message should appear.
    await expect(page.getByText('Registration successful')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('User cannot register with a duplicate email', async ({ page }) => {
    await mockRegister(page, false);
    await page.goto('/auth/register');

    await page.getByLabel('Email address').fill('existing@example.com');
    await page.getByLabel('Password').fill('Str0ng!Pass99');
    await page.getByRole('button', { name: 'Create account' }).click();

    // The API error message should be shown inline.
    await expect(
      page.getByRole('alert').filter({ hasText: 'already exists' }),
    ).toBeVisible();
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  test('User can log in with correct credentials', async ({ page }) => {
    await mockLogin(page, true);
    await page.goto('/auth/login');

    await page.getByLabel('Email address').fill('user@example.com');
    await page.getByLabel('Password').fill('correctpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // After a successful login the app redirects away from /auth/login.
    await expect(page).not.toHaveURL(/\/auth\/login/);
  });

  test('User sees an error with wrong credentials', async ({ page }) => {
    await mockLogin(page, false);
    await page.goto('/auth/login');

    await page.getByLabel('Email address').fill('user@example.com');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid email or password' }),
    ).toBeVisible();
    // The user should remain on the login page.
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  // ── Password reset ────────────────────────────────────────────────────────

  test('User can request a password reset via email link', async ({ page }) => {
    await mockForgotPassword(page);
    await page.goto('/auth/forgot-password');

    await page.getByLabel('Email address').fill('user@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    // Confirmation screen should appear.
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(
      page.getByText(/If an account with that address exists/),
    ).toBeVisible();
  });

  // ── 2FA ───────────────────────────────────────────────────────────────────

  test('2FA enrollment succeeds with a valid TOTP code', async ({ page }) => {
    await mock2FA(page, true);
    await page.goto('/auth/2fa');

    // The QR code image should be visible.
    await expect(page.getByAltText('2FA QR code')).toBeVisible();

    // Fill in a 6-digit code and submit.
    await page.getByLabel('Verification code').fill('123456');
    await page.getByRole('button', { name: 'Enable 2FA' }).click();

    await expect(page.getByText('Two-factor authentication enabled')).toBeVisible();
  });

  test('2FA enrollment shows an error for an invalid TOTP code', async ({ page }) => {
    await mock2FA(page, false);
    await page.goto('/auth/2fa');

    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Enable 2FA' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid TOTP code' }),
    ).toBeVisible();
  });
});
