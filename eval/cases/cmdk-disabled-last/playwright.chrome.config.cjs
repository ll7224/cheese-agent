// Solution-free local runner: use the candidate's original test assertions.
const path = require('node:path');
const root = process.cwd();
if (!process.env.CHEESE_CASE_OUTPUT) {
  throw new Error('Set CHEESE_CASE_OUTPUT outside the cmdk workspace.');
}
module.exports = {
  testDir: path.join(root, 'test'),
  testMatch: 'keybind.test.ts',
  outputDir: path.resolve(process.env.CHEESE_CASE_OUTPUT),
  timeout: 5000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: 'chrome', headless: true } }],
  use: { baseURL: 'http://127.0.0.1:43817', screenshot: 'on', trace: 'off' },
  webServer: {
    command: 'pnpm exec next dev -H 127.0.0.1 -p 43817',
    url: 'http://127.0.0.1:43817/keybinds',
    cwd: path.join(root, 'test'),
    reuseExistingServer: false,
    timeout: 60000,
  },
};
