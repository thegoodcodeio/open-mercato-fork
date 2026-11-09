import { expect, test, type Page } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  buildDefinition,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  uniqueSuffix,
} from './helpers/fixtures'
import { MODELS_LIST_URL, renameFeature, studioUrl } from './helpers/studioUi'

const LEAVE_QUESTION = 'You have unsaved changes. Are you sure you want to leave?'
const LIST_URL_PATTERN = new RegExp(`${MODELS_LIST_URL}(\\?.*)?$`)

function leaveDialog(page: Page) {
  return page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: LEAVE_QUESTION })
}

async function expectStudioKeepsDraft(page: Page, path: string, featureLabel: string): Promise<void> {
  await expect(leaveDialog(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`${path}$`))
  await expect(page.getByTestId('model-studio')).toBeVisible()
  await expect(page.getByTestId('studio-tab-panel-features').getByText(featureLabel, { exact: true })).toBeVisible()
  await expect(page.getByText('Unsaved changes: save first, Validate and Publish use the saved draft.')).toBeVisible()
}

test.describe('TC-PCFG-034: browser Back and Forward with unsaved studio changes', () => {
  test.use({ actionTimeout: 15_000 })

  test('cancelling Back or Forward keeps the studio and its draft; confirming Back leaves', async ({ page, request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const title = `QA PCFG 034 ${suffix}`
    let productId: string | null = null
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title, sku: `QA-PCFG-034-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      modelId = await createModelFixture(request, token, { productId, priceKindId, title, draftDefinition: buildDefinition({ priceKindId }) })
      const studioPath = studioUrl(modelId)

      await login(page, 'admin')
      await page.goto(MODELS_LIST_URL, { waitUntil: 'domcontentloaded' })
      await page.getByPlaceholder('Search by title or key').fill(title)
      await page.getByRole('cell', { name: title }).first().click({ timeout: 30_000 })
      await expect(page).toHaveURL(new RegExp(`${studioPath}$`))
      await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })

      await page.getByRole('link', { name: 'Models', exact: true }).first().click()
      await expect(page).toHaveURL(LIST_URL_PATTERN)
      await page.evaluate(() => window.history.back())
      await expect(page).toHaveURL(new RegExp(`${studioPath}$`))
      await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })

      await renameFeature(page, 'Size', 'Size (unsaved)')

      await page.evaluate(() => window.history.forward())
      await expect(leaveDialog(page)).toHaveCount(1)
      await leaveDialog(page).getByRole('button', { name: 'Cancel' }).click()
      await expectStudioKeepsDraft(page, studioPath, 'Size (unsaved)')

      await page.evaluate(() => window.history.back())
      await expect(leaveDialog(page)).toHaveCount(1)
      await leaveDialog(page).getByRole('button', { name: 'Cancel' }).click()
      await expectStudioKeepsDraft(page, studioPath, 'Size (unsaved)')

      await page.evaluate(() => window.history.back())
      await expect(leaveDialog(page)).toHaveCount(1)
      await leaveDialog(page).getByRole('button', { name: 'Confirm' }).click()
      await expect(page).toHaveURL(LIST_URL_PATTERN)
      await expect(page.getByTestId('model-studio')).toHaveCount(0)
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
})
