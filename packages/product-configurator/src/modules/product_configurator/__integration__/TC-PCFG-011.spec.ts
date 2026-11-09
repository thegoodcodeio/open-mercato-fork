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
  uniqueSuffix,
} from './helpers/fixtures'
import { openStudio, openTab } from './helpers/studioUi'

test.describe('TC-PCFG-011: formula parse errors in the studio', () => {
  test.use({ actionTimeout: 15_000 })

  test('shows a parse error inline and fixes a close match with one click', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let productId: string | null = null
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title: `QA PCFG 011 ${suffix}`, sku: `QA-PCFG-011-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      const definition = buildDefinition({ priceKindId })
      const features = [
        ...(definition.features as Record<string, unknown>[]),
        { key: 'length_m', label: 'Length', type: 'number', min: 1, max: 10, default: 2, order: 2, inSummary: true },
      ]
      modelId = await createModelFixture(request, token, { productId, priceKindId, draftDefinition: { ...definition, features } })

      await login(page, 'admin')
      await openStudio(page, modelId)
      await openTab(page, 'Formulas')
      await page.getByRole('button', { name: 'Add formula', exact: true }).click()
      const editor = page.getByTestId('formula-editor')
      const expression = editor.getByRole('combobox', { name: 'Expression' })

      await expression.fill('feature.lenght_m * 2')
      await expression.press('Tab')
      await expect(expression).toHaveAttribute('aria-invalid', 'true')
      const error = editor.getByText('No feature named "lenght_m".')
      await expect(error).toBeVisible()
      await expect(editor.getByText('Did you mean Length (length_m)?')).toBeVisible()

      await editor.getByRole('button', { name: 'Use it' }).click()
      await expect(expression).toHaveValue('feature.length_m * 2')
      await expect(error).toHaveCount(0)
      await expect(expression).not.toHaveAttribute('aria-invalid', 'true')
      await expect(editor.getByTestId('formula-editor-preview')).toHaveText('4')

      await expression.fill('feature.length_m * (2')
      await expression.press('Tab')
      await expect(editor.getByText('The parentheses do not match.')).toBeVisible()
      await editor.getByLabel('Key', { exact: true }).fill('double_length')
      await editor.getByRole('button', { name: 'Save formula', exact: true }).click()
      await expect(editor, 'a formula that does not parse is not saved').toBeVisible()
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
})
