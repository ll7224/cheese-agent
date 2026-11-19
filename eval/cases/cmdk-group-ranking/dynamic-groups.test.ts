import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/dynamic-groups') })

const headings = (page) => page.locator('[cmdk-group]:not([hidden]) [cmdk-group-heading]')

test('initial search ranks groups by their best matching item', async ({ page }) => {
  await page.locator('[cmdk-input]').fill('rank')
  await expect(headings(page)).toHaveText(['Projects', 'Actions'])
  await expect(page.locator('[cmdk-item]')).toHaveCount(3)
})

test('changing search reorders intact groups by their best matching item', async ({ page }) => {
  await page.locator('[cmdk-input]').fill('actions-first')
  await expect(headings(page)).toHaveText(['Actions', 'Projects'])
  await page.locator('[cmdk-input]').fill('rank')
  await expect(headings(page)).toHaveText(['Projects', 'Actions'])
})

test('removing an item before searching does not corrupt later group ranking', async ({ page }) => {
  await page.locator('button', { hasText: 'Remove temporary item' }).click()
  await expect(page.locator('[cmdk-item][data-value="temporary"]')).toHaveCount(0)
  await page.locator('[cmdk-input]').fill('rank')
  await expect(headings(page)).toHaveText(['Actions', 'Projects'])
  await expect(page.locator('[cmdk-item]')).toHaveCount(2)
})

test('active search updates group order and selection when items are removed and restored', async ({ page }) => {
  await page.locator('[cmdk-input]').fill('rank')
  await expect(headings(page)).toHaveText(['Projects', 'Actions'])
  await page.locator('button', { hasText: 'Remove temporary item' }).click()
  await expect(page.locator('[cmdk-item][data-value="temporary"]')).toHaveCount(0)
  await expect(headings(page)).toHaveText(['Actions', 'Projects'])
  await expect(page.locator('[cmdk-item][aria-selected="true"]')).toHaveAttribute('data-value', 'action')
  await page.locator('button', { hasText: 'Add temporary item' }).click()
  await expect(headings(page)).toHaveText(['Projects', 'Actions'])
  await expect(page.locator('[cmdk-item]')).toHaveCount(3)
})
