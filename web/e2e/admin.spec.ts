import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mocks the POST /api/admin/tools endpoint to simulate installing a new tool.
 */
async function mockInstallTool(page: Page, succeed: boolean): Promise<void> {
  await page.route('**/api/admin/tools', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (succeed) {
      const body = route.request().postDataJSON() as { name?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `tool-${Date.now()}`,
          name: body.name ?? 'unknown-tool',
          version: '1.0.0',
          status: 'installed',
        }),
      });
    } else {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Installation failed' }),
      });
    }
  });
}

/**
 * Mocks the POST /api/admin/workflows endpoint to simulate workflow creation.
 */
async function mockCreateWorkflow(page: Page, succeed: boolean): Promise<void> {
  await page.route('**/api/admin/workflows', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (succeed) {
      const body = route.request().postDataJSON() as {
        name?: string;
        steps?: { name: string; action: string }[];
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `wf-${Date.now()}`,
          name: body.name ?? 'Unnamed workflow',
          steps: (body.steps ?? []).map((s, i) => ({ ...s, id: `step-${i}` })),
        }),
      });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not create workflow' }),
      });
    }
  });
}

/**
 * Mocks the PATCH /api/admin/policies/:id endpoint.
 */
async function mockUpdatePolicy(page: Page, succeed: boolean): Promise<void> {
  await page.route(/\/api\/admin\/policies\/.*/, async (route) => {
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
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not update policy' }),
      });
    }
  });
}

/**
 * Mocks the POST /api/admin/api-keys/:id/revoke endpoint.
 */
async function mockRevokeKey(page: Page, succeed: boolean): Promise<void> {
  await page.route(/\/api\/admin\/api-keys\/.*\/revoke/, async (route) => {
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
        body: JSON.stringify({ error: 'Could not revoke API key' }),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Admin workflow tests
// ---------------------------------------------------------------------------

test.describe('Admin workflows', () => {
  // ── Tool installation ─────────────────────────────────────────────────────

  test('Admin can install a new tool from the dashboard', async ({ page }) => {
    await mockInstallTool(page, true);
    await page.goto('/admin/tools');

    await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();

    // Fill in the tool name and submit the form.
    await page.getByLabel('Tool name').fill('openai-mcp-server');
    await page.getByRole('button', { name: 'Install tool' }).click();

    // The newly installed tool should appear in the installed tools list.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'openai-mcp-server' }),
    ).toBeVisible();

    // The status should reflect a completed install.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'installed' }),
    ).toBeVisible();
  });

  // ── Workflow creation ─────────────────────────────────────────────────────

  test('Admin can create a workflow with 2 steps', async ({ page }) => {
    await mockCreateWorkflow(page, true);
    await page.goto('/admin/workflows');

    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();

    // Fill in the workflow name.
    await page.getByLabel('Workflow name').fill('Daily digest');

    // Fill in step 1.
    await page.getByLabel('Step name').nth(0).fill('Fetch data');
    await page.getByLabel('Action').nth(0).fill('tool:fetch');

    // Fill in step 2.
    await page.getByLabel('Step name').nth(1).fill('Send report');
    await page.getByLabel('Action').nth(1).fill('tool:email');

    await page.getByRole('button', { name: 'Create workflow' }).click();

    // The new workflow should appear in the list with the correct step count.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Daily digest' }),
    ).toBeVisible();
    await expect(
      page.getByRole('listitem').filter({ hasText: '2 steps' }),
    ).toBeVisible();
  });

  // ── Policy update ─────────────────────────────────────────────────────────

  test('Admin can update a policy rule', async ({ page }) => {
    await mockUpdatePolicy(page, true);
    await page.goto('/admin/policies');

    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();

    // The default "Allow admin reads" policy should be visible.
    await expect(page.getByText('Allow admin reads')).toBeVisible();

    // Click the Edit button for the first policy.
    await page.getByRole('button', { name: 'Edit' }).first().click();

    // The edit form should appear.
    await expect(page.getByLabel('Policy name')).toBeVisible();

    // Change the policy name and effect.
    await page.getByLabel('Policy name').fill('Deny all writes');
    await page.getByLabel('Effect').selectOption('deny');
    await page.getByRole('button', { name: 'Save changes' }).click();

    // The updated policy should be reflected in the list.
    await expect(page.getByText('Deny all writes')).toBeVisible();
  });

  // ── API key revocation ────────────────────────────────────────────────────

  test("Admin can revoke a user's API key", async ({ page }) => {
    await mockRevokeKey(page, true);
    await page.goto('/admin/users');

    await expect(page.getByRole('heading', { name: 'Users & API Keys' })).toBeVisible();

    // There should be at least one active key with a Revoke button.
    const revokeButton = page
      .getByRole('button', { name: /Revoke/i })
      .first();
    await expect(revokeButton).toBeVisible();

    await revokeButton.click();

    // After revocation the key's status cell should show "Revoked".
    await expect(page.getByRole('cell', { name: 'Revoked' }).first()).toBeVisible();

    // The Revoke button should no longer be present for the revoked key.
    await expect(
      page.getByRole('row').filter({ hasText: 'Production key' }).getByRole('button'),
    ).toBeHidden();
  });
});
