import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './unit',
  testMatch: 'route-probe.spec.ts',
  tsconfig: '../tsconfig.app.json',
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/route-probe',
})
