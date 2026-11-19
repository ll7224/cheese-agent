const base = require('../../cases/cmdk-group-ranking/playwright.chrome.config.cjs');
module.exports = {
  ...base,
  testDir: __dirname,
  testMatch: 'duplicate-groups.test.js',
  webServer: { ...base.webServer, url: 'http://127.0.0.1:43818/duplicate-groups' },
};
