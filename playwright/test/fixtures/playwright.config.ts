import { defineConfig } from '@playwright/test';

// The rows' Playwright project: one worker, no retries, as keploy runs a suite.
export default defineConfig({
  testDir: '.',
  workers: 1,
  retries: 0,
  timeout: Number(process.env.PW_TIMEOUT || 30000),
  reporter: [['json'], ['./steps-reporter.cjs']],
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  projects: [{ name: 'p1', use: { headless: true } }],
});
