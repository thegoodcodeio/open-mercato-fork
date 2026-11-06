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
  publishModel,
  readModel,
  uniqueSuffix,
} from './helpers/fixtures'
import { firstFeatureLabel, openStudio, publish, renameFeature, saveDraft, studioButton } from './helpers/studioUi'

test.describe('TC-PCFG-015: save, reload, keep editing, publish', () => {
  test.use({ actionTimeout: 15_000 })

  test('a saved draft survives a reload, the unpublished flag follows the draft hash, and the next version publishes', async ({ page, request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-015-PART-${suffix}`
    const productIds: string[] = []
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 015 ${suffix}`, sku: `QA-PCFG-015-${suffix}` }))
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 015 part ${suffix}`, sku: partSku }))
      priceKindId = await createPriceKindFixture(request, token)
      modelId = await createModelFixture(request, token, {
        productId: productIds[0],
        priceKindId,
        draftDefinition: buildDefinition({ priceKindId, partSku }),
      })
      const created = await readModel(request, token, modelId)
      expect((await publishModel(request, token, modelId, created.updatedAt)).status()).toBe(200)

      await login(page, 'admin')
      await openStudio(page, modelId)
      const header = page.getByTestId('studio-header')
      const unpublished = header.getByText('Unpublished changes', { exact: true })
      await expect(header.getByText('Published v1', { exact: true })).toBeVisible()
      await expect(unpublished).toHaveCount(0)
      await expect(studioButton(page, 'Publish'), 'nothing to publish yet').toBeDisabled()

      await renameFeature(page, 'Size', 'Pump size')
      await saveDraft(page)
      await expect(unpublished).toBeVisible()

      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })
      await expect(unpublished).toBeVisible()
      await expect(page.getByText('No unsaved changes.')).toBeVisible()

      await renameFeature(page, 'Pump size', 'Size')
      await saveDraft(page)
      await expect(unpublished, 'a draft equal to v1 has no unpublished changes').toHaveCount(0)
      await expect(studioButton(page, 'Publish')).toBeDisabled()

      await renameFeature(page, 'Size', 'Pump body size')
      await saveDraft(page)
      await expect(unpublished).toBeVisible()
      await publish(page)
      await expect(header.getByText('Published v2', { exact: true })).toBeVisible()
      await expect(unpublished).toHaveCount(0)

      const saved = await readModel(request, token, modelId)
      expect(saved.latestVersion?.version).toBe(2)
      expect(saved.hasUnpublishedChanges).toBe(false)
      expect(firstFeatureLabel(saved.draftDefinition)).toBe('Pump body size')
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
