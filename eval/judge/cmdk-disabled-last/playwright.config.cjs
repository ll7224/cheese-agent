const path = require('node:path');

// Run from the prepared cmdk root with its pinned Playwright installation.
const root = process.cwd();
const upstream = require(path.join(root, 'playwright.config.ts')).default;

if (!process.env.CHEESE_CASE_OUTPUT) {
  throw new Error('Set CHEESE_CASE_OUTPUT to an evidence directory outside the cmdk workspace.');
}

module.exports = {
  ...upstream,
  testDir: __dirname,
  testMatch: 'keybind.test.js',
  outputDir: path.resolve(process.env.CHEESE_CASE_OUTPUT),
  workers: 1,
  retries: 0,
  reporter: 'list',
  // WebKit 16.0 cannot open a page on the current macOS 26.5 host.
  // Keep the upstream runner/tests; explicitly use installed Chrome for this case.
  projects: [
    {
      name: 'chrome',
      use: { browserName: 'chromium', channel: 'chrome', headless: true },
    },
  ],
  use: {
    ...upstream.use,
    baseURL: 'http://127.0.0.1:43817',
    screenshot: 'on',
    trace: 'off',
  },
  webServer: {
    command: 'pnpm exec next dev -H 127.0.0.1 -p 43817',
    url: 'http://127.0.0.1:43817/keybinds',
    cwd: path.join(root, 'test'),
    reuseExistingServer: false,
    timeout: 60000,
  },
};
