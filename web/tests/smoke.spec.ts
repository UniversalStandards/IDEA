import { expect, test } from '@playwright/test'

test('loads the design system homepage', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/IDEA Design System/i)
  await expect(page.getByRole('heading', { name: 'IDEA Design System' })).toBeVisible()
})
