const path = require('node:path');
const root = process.cwd();
if (!process.env.CHEESE_CASE_OUTPUT) throw new Error('Set CHEESE_CASE_OUTPUT outside the workspace.');
module.exports = {
  testDir: path.join(root, 'test'),
  testMatch: ['dynamic-groups.test.ts', 'keybind.test.ts', 'group.test.ts'],
  outputDir: path.resolve(process.env.CHEESE_CASE_OUTPUT),
  timeout: 5000, workers: 1, retries: 0, reporter: 'list',
  projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: 'chrome', headless: true } }],
  use: { baseURL: 'http://127.0.0.1:43818', screenshot: 'only-on-failure', trace: 'off' },
  webServer: {
    command: 'pnpm exec next dev -H 127.0.0.1 -p 43818',
    url: 'http://127.0.0.1:43818/dynamic-groups',
    cwd: path.join(root, 'test'), reuseExistingServer: false, timeout: 60000,
  },
};
