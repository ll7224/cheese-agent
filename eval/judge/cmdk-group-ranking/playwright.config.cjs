const base = require('../../cases/cmdk-group-ranking/playwright.chrome.config.cjs');
module.exports = {
  ...base,
  testDir: __dirname,
  testMatch: ['dynamic-groups.test.js', 'keybind.test.js', 'group.test.js'],
};
