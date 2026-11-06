import { expect, test } from '@playwright/test'
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
  readModel,
  saveModel,
  uniqueSuffix,
} from './helpers/fixtures'
import { firstFeatureLabel, openStudio, renameFeature, studioButton, withFirstFeatureLabel } from './helpers/studioUi'

test.describe('TC-PCFG-012: conflict bar on a concurrent edit', () => {
  test.use({ actionTimeout: 15_000 })

  test('a save over a newer server version shows the conflict bar and keeps the local edits', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let productId: string | null = null
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title: `QA PCFG 012 ${suffix}`, sku: `QA-PCFG-012-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      const definition = buildDefinition({ priceKindId })
      modelId = await createModelFixture(request, token, { productId, priceKindId, draftDefinition: definition })

      await login(page, 'admin')
      await openStudio(page, modelId)

      const loaded = await readModel(request, token, modelId)
      const concurrent = await saveModel(request, token, {
        id: modelId,
        updatedAt: loaded.updatedAt,
        draftDefinition: withFirstFeatureLabel(definition, 'Size (saved by someone else)'),
      })
      expect(concurrent.status()).toBe(200)

      await renameFeature(page, 'Size', 'Size (local edit)')
      await studioButton(page, 'Save draft').click()

      const conflict = page.getByTestId('studio-conflict-alert')
      await expect(conflict).toBeVisible({ timeout: 15_000 })
      await expect(conflict).toContainText('Record changed')
      await expect(conflict.getByRole('button', { name: 'Copy my draft (JSON)' })).toBeVisible()
      await expect(conflict.getByRole('button', { name: 'Refresh…' })).toBeVisible()
      await expect(studioButton(page, 'Save draft')).toBeEnabled()
      await expect(page.getByText('Size (local edit)', { exact: true })).toBeVisible()

      const server = await readModel(request, token, modelId)
      expect(firstFeatureLabel(server.draftDefinition), 'the refused save did not overwrite the newer version').toBe('Size (saved by someone else)')
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
})
