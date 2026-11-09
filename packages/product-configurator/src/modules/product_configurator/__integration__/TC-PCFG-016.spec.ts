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
import { openStudio, renameFeature, studioButton, withFirstFeatureLabel } from './helpers/studioUi'

test.describe('TC-PCFG-016: conflict refresh and discard', () => {
  test.use({ actionTimeout: 15_000 })

  test('refresh after a conflict asks first and offers a copy of the local draft; discard restores the saved draft', async ({ page, context, request }) => {
    test.setTimeout(180_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let productId: string | null = null
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title: `QA PCFG 016 ${suffix}`, sku: `QA-PCFG-016-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      const definition = buildDefinition({ priceKindId })
      modelId = await createModelFixture(request, token, { productId, priceKindId, draftDefinition: definition })

      await login(page, 'admin')
      await openStudio(page, modelId)
      const features = page.getByTestId('studio-tab-panel-features')

      await renameFeature(page, 'Size', 'Size (to discard)')
      await studioButton(page, 'Discard unsaved changes').click()
      const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'))
      await expect(confirm.getByText('Discard unsaved changes?')).toBeVisible()
      await confirm.getByRole('button', { name: 'Discard changes' }).click()
      await expect(page.getByText('No unsaved changes.')).toBeVisible()
      await expect(features.getByText('Size', { exact: true })).toBeVisible()
      await expect(features.getByText('Size (to discard)', { exact: true })).toHaveCount(0)

      const loaded = await readModel(request, token, modelId)
      const concurrent = await saveModel(request, token, {
        id: modelId,
        updatedAt: loaded.updatedAt,
        draftDefinition: withFirstFeatureLabel(definition, 'Size (server)'),
      })
      expect(concurrent.status()).toBe(200)

      await renameFeature(page, 'Size', 'Size (mine)')
      await studioButton(page, 'Save draft').click()
      const conflict = page.getByTestId('studio-conflict-alert')
      await expect(conflict).toBeVisible({ timeout: 15_000 })

      await conflict.getByRole('button', { name: 'Refresh…' }).click()
      const refreshDialog = page.getByTestId('studio-conflict-refresh-dialog')
      await expect(refreshDialog.getByText('Refresh and lose your changes?')).toBeVisible()
      await refreshDialog.getByRole('button', { name: 'Copy my draft (JSON)' }).click()
      await expect(page.getByText('Your draft is copied to the clipboard as JSON.')).toBeVisible()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expect(copied).toContain('"Size (mine)"')

      await refreshDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(refreshDialog).toHaveCount(0)
      await expect(features.getByText('Size (mine)', { exact: true }), 'cancel keeps the local edits').toBeVisible()

      await conflict.getByRole('button', { name: 'Refresh…' }).click()
      await expect(refreshDialog).toBeVisible()
      await page.keyboard.press('Control+Enter')
      await expect(conflict).toHaveCount(0)
      await expect(page.getByText('No unsaved changes.')).toBeVisible()
      await page.getByRole('tab', { name: /^Features/ }).click()
      await expect(page.getByTestId('studio-tab-panel-features').getByText('Size (server)', { exact: true })).toBeVisible()
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
})
