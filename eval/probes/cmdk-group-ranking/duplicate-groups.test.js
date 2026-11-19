const { expect, test } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }));

test('groups with identical headings keep independent identity when sorting', async ({ page }) => {
  await page.goto('/duplicate-groups');
  await page.locator('[cmdk-input]').fill('rank');
  await expect(page.locator('[cmdk-group]').first()).toHaveAttribute('data-testid', 'high-score-group');
});
