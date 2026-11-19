// Adapted from dip/cmdk; MIT, see ../../cases/cmdk-group-ranking/LICENSE.md.
const { expect, test } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

test.describe('group', async () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/group')
  })

  test('groups are shown/hidden based on item matches', async ({ page }) => {
    await page.locator(`[cmdk-input]`).type('z')
    await expect(page.locator(`[cmdk-group][data-value="animals"]`)).not.toBeVisible()
    await expect(page.locator(`[cmdk-group][data-value="letters"]`)).toBeVisible()
  })

  test('group can be progressively rendered', async ({ page }) => {
    await expect(page.locator(`[cmdk-group][data-value="numbers"]`)).not.toBeVisible()
    await page.locator(`[cmdk-input]`).type('t')
    await expect(page.locator(`[cmdk-group][data-value="animals"]`)).not.toBeVisible()
    await expect(page.locator(`[cmdk-group][data-value="letters"]`)).not.toBeVisible()
    await expect(page.locator(`[cmdk-group][data-value="numbers"]`)).toBeVisible()
  })
})
