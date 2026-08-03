import { defineConfig } from '@playwright/test'

const frontendPort = process.env['FRONTEND_PORT'] ?? '3000'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${frontendPort}`,
    headless: true,
  },
})
