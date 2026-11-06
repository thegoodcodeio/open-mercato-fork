import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { PREVIEW_PATH, readModel, saveModel, uniqueSuffix } from './helpers/fixtures'
import {
  Cleanup,
  createCompany,
  createPrice,
  createProduct,
  createPublishedModel,
  createPriceKind,
  createSalesChannel,
  createSinglePartModel,
  singlePartDefinition,
} from './helpers/sessions'
import { openStudio, openTab } from './helpers/studioUi'

/**
 * Prices, worked out by hand:
 * - published v1 has one part (A, base 100.00); the saved draft adds 2 x part B (30.00) and a warning rule for Large
 * - reference context, Small: 100.00; Large: 100.00 + 2 x 30.00 = 160.00
 * - channel context (A has a channel row 72.50), Large: 72.50 + 60.00 = 132.50
 */
test.describe('TC-PCFG-017: studio Test tab previews the saved draft without a session', () => {
  test.use({ actionTimeout: 15_000 })

  test('evaluates the saved draft in the reference context and for a chosen channel, and stores no session or snapshot', async ({ page, request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const cleanup = new Cleanup()

    try {
      const productId = await createProduct(request, token, cleanup, { title: `QA PCFG 017 ${suffix}`, sku: `QA-PCFG-017-${suffix}` })
      const partA = `QA-PCFG-017-A-${suffix}`
      const partB = `QA-PCFG-017-B-${suffix}`
      const partAId = await createProduct(request, token, cleanup, { title: `QA PCFG 017 frame ${suffix}`, sku: partA })
      const partBId = await createProduct(request, token, cleanup, { title: `QA PCFG 017 brace ${suffix}`, sku: partB })
      const priceKindId = await createPriceKind(request, token, cleanup)
      const channelName = `QA PCFG 017 dealers ${suffix}`
      const channelId = await createSalesChannel(request, token, cleanup, channelName)
      await createPrice(request, token, cleanup, { productId: partAId, priceKindId, unitPriceNet: '100.00' })
      await createPrice(request, token, cleanup, { productId: partAId, priceKindId, unitPriceNet: '72.50', channelId })
      await createPrice(request, token, cleanup, { productId: partBId, priceKindId, unitPriceNet: '30.00' })

      const published = await createPublishedModel(request, token, cleanup, { productId, priceKindId, definition: singlePartDefinition(partA) })
      const v1 = await readModel(request, token, published.modelId)
      const draft = {
        ...singlePartDefinition(partA),
        commercial: { currencyCode: 'EUR', priceKindId, allowPromotions: false },
        rules: [
          {
            id: 'large-note',
            label: 'Large note',
            effect: 'warning',
            when: [{ kind: 'compare', featureKey: 'size', op: 'eq', value: 'l' }],
            messageTemplate: 'Large frames need two braces.',
            featureKeys: ['size'],
            order: 1,
          },
        ],
        bom: [
          { id: 'part', sku: partA, uom: 'pc', quantity: 1, when: [], order: 1 },
          { id: 'brace', sku: partB, uom: 'pc', quantity: 2, when: [{ kind: 'compare', featureKey: 'size', op: 'eq', value: 'l' }], order: 2 },
        ],
      }
      const saved = await saveModel(request, token, { id: published.modelId, updatedAt: v1.updatedAt, draftDefinition: draft })
      expect(saved.status(), `saving the draft should return 200: ${await saved.text()}`).toBe(200)
      const savedAt = ((await saved.json()) as { updatedAt: string }).updatedAt

      await login(page, 'admin')
      await openStudio(page, published.modelId)
      await openTab(page, 'Test')
      const tab = page.getByTestId('studio-test-tab')
      const netPrice = tab.getByTestId('configurator-net-price')

      await expect(tab.getByTestId('preview-reference-context')).toBeVisible()
      await expect(netPrice).toHaveText('€100.00', { timeout: 30_000 })
      await expect(tab.getByTestId('studio-test-trace')).toHaveText('No rule fired for these choices.')

      await tab.getByTestId('configurator-option-size-l').click()
      await expect(netPrice).toHaveText('€160.00', { timeout: 30_000 })
      await expect(tab.getByTestId('configurator-bom')).toContainText(partB)
      await expect(tab.getByTestId('configurator-messages')).toContainText('Large frames need two braces.')
      await expect(tab.getByTestId('studio-test-trace')).toHaveText('Rules that fired: Large note (large-note)')

      const previewResponse = page.waitForResponse(
        (response) => response.url().includes('/api/product_configurator/models/preview') && response.request().postData()?.includes(channelId) === true,
      )
      const channelInput = tab.getByTestId('preview-context-channel').getByRole('combobox')
      await channelInput.fill(channelName)
      await page.getByRole('option', { name: new RegExp(channelName) }).click()
      const response = await previewResponse
      expect(response.status()).toBe(200)
      const body = (await response.json()) as { evaluation: { modelVersionId: string; priceContext: { channelId: string | null } }; referenceContext: boolean }
      expect(body.referenceContext).toBe(false)
      expect(body.evaluation.modelVersionId).toBe(published.modelId)
      expect(body.evaluation.priceContext.channelId).toBe(channelId)
      await expect(netPrice).toHaveText('€132.50', { timeout: 30_000 })
      await expect(tab.getByTestId('preview-reference-context')).toHaveCount(0)

      const stored = await withClient(async (client) => {
        const sessions = await client.query<{ count: string }>(
          'select count(*)::text as count from product_configurator_sessions where model_version_id in ($1, $2)',
          [published.modelVersionId, published.modelId],
        )
        const snapshots = await client.query<{ count: string }>(
          'select count(*)::text as count from product_configurator_snapshots where model_version_id in ($1, $2)',
          [published.modelVersionId, published.modelId],
        )
        return { sessions: sessions.rows[0]?.count, snapshots: snapshots.rows[0]?.count }
      })
      expect(stored).toEqual({ sessions: '0', snapshots: '0' })

      const after = await readModel(request, token, published.modelId)
      expect(after.updatedAt, 'the preview does not write the model').toBe(savedAt)
    } finally {
      await cleanup.run()
    }
  })

  test('prices only for a customer and channel of the selected organization', async ({ request }) => {
    test.setTimeout(120_000)
    const adminToken = await getAuthToken(request, 'admin')
    const superadminToken = await getAuthToken(request, 'superadmin')
    const { tenantId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const cleanup = new Cleanup()
    let otherOrganizationId: string | null = null
    try {
      const model = await createSinglePartModel(request, adminToken, cleanup, '017B')
      const homeCustomerId = await createCompany(request, adminToken, cleanup, `QA PCFG 017 home ${suffix}`)
      otherOrganizationId = await createOrganizationFixture(request, superadminToken, { name: `QA PCFG 017 ${suffix}`, tenantId })
      const otherCustomerId = await createCompany(request, superadminToken, cleanup, `QA PCFG 017 other ${suffix}`, otherOrganizationId)
      const otherChannelId = await createSalesChannel(request, superadminToken, cleanup, `QA PCFG 017 other ${suffix}`, otherOrganizationId)
      const previewFor = (context: Record<string, string>) =>
        apiRequest(request, 'POST', PREVIEW_PATH, { token: adminToken, data: { id: model.modelId, selections: {}, context } })

      const home = await previewFor({ customerId: homeCustomerId })
      expect(home.status(), await home.text()).toBe(200)
      const homeBody = await readJsonSafe<{ evaluation: { priceContext: { customerId: string | null } } }>(home)
      expect(homeBody?.evaluation.priceContext.customerId).toBe(homeCustomerId)

      const otherCustomer = await previewFor({ customerId: otherCustomerId })
      expect(otherCustomer.status()).toBe(404)
      const otherCustomerBody = await readJsonSafe<{ code: string; evaluation?: unknown }>(otherCustomer)
      expect(otherCustomerBody?.code).toBe('customer_not_found')
      expect(otherCustomerBody?.evaluation).toBeUndefined()

      const otherChannel = await previewFor({ channelId: otherChannelId })
      expect(otherChannel.status()).toBe(404)
      expect((await readJsonSafe<{ code: string }>(otherChannel))?.code).toBe('channel_not_found')
    } finally {
      await cleanup.run()
      await deleteOrganizationIfExists(request, superadminToken, otherOrganizationId)
    }
  })
})
