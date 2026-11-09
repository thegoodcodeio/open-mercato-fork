import { expect, test, type Page } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  buildDefinition,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  publishModel,
  readModel,
  uniqueSuffix,
} from './helpers/fixtures'
import { MODELS_LIST_URL, openTab, studioUrl, versionUrl } from './helpers/studioUi'

const HYDRATION_ERROR = /hydrat|did not match|server rendered|Minified React error #4(18|19|23|25)/i

function collectErrors(page: Page): { console: string[]; uncaught: string[] } {
  const errors: { console: string[]; uncaught: string[] } = { console: [], uncaught: [] }
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text())
  })
  page.on('pageerror', (error) => errors.uncaught.push(error.message))
  return errors
}

test.describe('TC-PCFG-014: hydration smoke test of the studio pages', () => {
  test.use({ actionTimeout: 15_000 })

  test('models list, studio and published version page mount without hydration or runtime errors', async ({ page, request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-014-PART-${suffix}`
    const title = `QA PCFG 014 ${suffix}`
    const productIds: string[] = []
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productIds.push(await createUnitProductFixture(request, token, { title, sku: `QA-PCFG-014-${suffix}` }))
      productIds.push(await createUnitProductFixture(request, token, { title: `${title} part`, sku: partSku }))
      priceKindId = await createPriceKindFixture(request, token)
      modelId = await createModelFixture(request, token, {
        productId: productIds[0],
        priceKindId,
        title,
        draftDefinition: buildDefinition({ priceKindId, partSku }),
      })
      const draft = await readModel(request, token, modelId)
      const published = await publishModel(request, token, modelId, draft.updatedAt)
      expect(published.status()).toBe(200)
      const versionId = (await readJsonSafe<{ modelVersionId: string }>(published))?.modelVersionId ?? ''

      await login(page, 'admin')
      const errors = collectErrors(page)

      await page.goto(MODELS_LIST_URL, { waitUntil: 'domcontentloaded' })
      await page.getByPlaceholder('Search by title or key').fill(title)
      await expect(page.getByRole('cell', { name: title }).first()).toBeVisible({ timeout: 30_000 })

      await page.goto(studioUrl(modelId), { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })
      for (const tab of ['Features', 'Formulas', 'Lookups', 'Rules', 'BOM', 'Dependencies', 'Advanced (JSON)', 'Overview']) {
        await openTab(page, tab)
      }
      await expect(page.getByText('Published v1', { exact: true })).toBeVisible()

      await page.goto(versionUrl(modelId, versionId), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Version 1', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

      const all = [...errors.console, ...errors.uncaught]
      expect(all.filter((line) => HYDRATION_ERROR.test(line)), 'no hydration errors').toEqual([])
      expect(errors.uncaught, 'no uncaught runtime errors').toEqual([])
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
