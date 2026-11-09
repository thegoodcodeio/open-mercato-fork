import { expect, test } from '@playwright/test'
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
import { studioUrl, versionUrl } from './helpers/studioUi'

test.describe('TC-PCFG-013: published version page', () => {
  test.use({ actionTimeout: 15_000 })

  test('renders the frozen version read-only with its sections and hash', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-013-PART-${suffix}`
    const productIds: string[] = []
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 013 ${suffix}`, sku: `QA-PCFG-013-${suffix}` }))
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 013 part ${suffix}`, sku: partSku }))
      priceKindId = await createPriceKindFixture(request, token)
      modelId = await createModelFixture(request, token, {
        productId: productIds[0],
        priceKindId,
        draftDefinition: buildDefinition({ priceKindId, partSku }),
      })
      const draft = await readModel(request, token, modelId)
      const published = await publishModel(request, token, modelId, draft.updatedAt)
      expect(published.status()).toBe(200)
      const version = await readJsonSafe<{ modelVersionId: string; hash: string }>(published)
      const versionId = version?.modelVersionId ?? ''

      await login(page, 'admin')
      await page.goto(versionUrl(modelId, versionId), { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Version 1', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('Published versions cannot be changed. Edit the draft in the studio and publish again.')).toBeVisible()
      await expect(page.getByText(version?.hash ?? '', { exact: true })).toBeVisible()
      await expect(page.getByText('Small, Large').first()).toBeVisible()
      await expect(page.getByText(partSku).first()).toBeVisible()
      await expect(page.getByText('Definition (JSON)')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Back to studio' })).toHaveAttribute('href', studioUrl(modelId))
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
