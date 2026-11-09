import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createCustomerGroupFixture,
  createCustomerGroupMembershipFixture,
  deleteCustomerGroupIfExists,
  deleteCustomerGroupMembershipIfExists,
} from '@open-mercato/core/helpers/integration/customerGroupsFixtures'
import { uniqueSuffix } from './helpers/fixtures'
import {
  Cleanup,
  cancelSession,
  createCompany,
  createPrice,
  createPriceKind,
  createProduct,
  createPublishedModel,
  createQuote,
  createVariant,
  evaluateOk,
  openSession,
  openSessionId,
  readSession,
} from './helpers/sessions'

/**
 * Golden values, worked out by hand from the catalog rows below, not from the engine:
 * - frame: the quote customer's group row 80.00 x 1 = 80.00 (base row 100.00 for a customer outside the group)
 * - panel: the BLUE variant has no row of its own, so its product row 45.50 applies: x 2 = 91.00 (the RED row 60.00 never does)
 * - cable: the 0.5 m total is priced from the first tier (minQuantity 1) 12.3456: x 0.5 = 6.1728 -> 6.17
 *   net = 80.00 + 91.00 + 6.17 = 177.17
 * - 12 m of cable: the 10 m tier 9.00 x 12 = 108.00, net = 80.00 + 91.00 + 108.00 = 279.00
 * - without the group: 100.00 + 91.00 + 6.17 = 197.17
 */
test.describe('TC-PCFG-020: open a session and evaluate golden scenarios priced from the catalog', () => {
  test('prices a customer-group part, a variant from its product row and a 0.5 m total from the first tier', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const cleanup = new Cleanup()
    let groupId: string | null = null
    let membershipId: string | null = null

    try {
      const productId = await createProduct(request, token, cleanup, { title: `QA PCFG 020 machine ${suffix}`, sku: `QA-PCFG-020-${suffix}` })
      const frameSku = `QA-PCFG-020-FRAME-${suffix}`
      const panelSku = `QA-PCFG-020-PANEL-${suffix}`
      const blueSku = `QA-PCFG-020-BLUE-${suffix}`
      const cableSku = `QA-PCFG-020-CABLE-${suffix}`
      const frameId = await createProduct(request, token, cleanup, { title: `QA PCFG 020 frame ${suffix}`, sku: frameSku })
      const panelId = await createProduct(request, token, cleanup, { title: `QA PCFG 020 panel ${suffix}`, sku: panelSku })
      await createVariant(request, token, cleanup, { productId: panelId, name: `Blue panel ${suffix}`, sku: blueSku })
      const redId = await createVariant(request, token, cleanup, { productId: panelId, name: `Red panel ${suffix}`, sku: `QA-PCFG-020-RED-${suffix}` })
      const cableId = await createProduct(request, token, cleanup, { title: `QA PCFG 020 cable ${suffix}`, sku: cableSku, unit: 'm' })
      const priceKindId = await createPriceKind(request, token, cleanup)

      groupId = await createCustomerGroupFixture(request, token, { code: `qa-pcfg-020-${suffix}`, name: `QA PCFG 020 ${suffix}`, kind: 'b2b' })
      const customerId = await createCompany(request, token, cleanup, `QA PCFG 020 customer ${suffix}`)
      membershipId = await createCustomerGroupMembershipFixture(request, token, { groupId, customerId })

      await createPrice(request, token, cleanup, { productId: frameId, priceKindId, unitPriceNet: '100.00' })
      await createPrice(request, token, cleanup, { productId: frameId, priceKindId, unitPriceNet: '80.00', customerGroupId: groupId })
      await createPrice(request, token, cleanup, { productId: panelId, priceKindId, unitPriceNet: '45.50' })
      await createPrice(request, token, cleanup, { variantId: redId, productId: panelId, priceKindId, unitPriceNet: '60.00' })
      await createPrice(request, token, cleanup, { productId: cableId, priceKindId, unitPriceNet: '12.3456' })
      await createPrice(request, token, cleanup, { productId: cableId, priceKindId, unitPriceNet: '9.00', minQuantity: 10 })

      const model = await createPublishedModel(request, token, cleanup, {
        productId,
        priceKindId,
        title: `QA PCFG 020 ${suffix}`,
        definition: {
          schemaVersion: 1,
          fixedSpecification: [],
          features: [
            { key: 'length', label: 'Cable length', type: 'number', min: 0.5, max: 20, step: 0.5, unit: 'm', default: 0.5, order: 1, inSummary: true },
          ],
          rules: [],
          formulas: [{ key: 'cable_m', expr: { kind: 'feature', featureKey: 'length' }, unit: 'm', decimals: 1 }],
          lookups: [],
          bom: [
            { id: 'frame', sku: frameSku, uom: 'pc', quantity: 1, when: [], order: 1 },
            { id: 'panel', sku: blueSku, uom: 'pc', quantity: 2, when: [], order: 2 },
            { id: 'cable', sku: cableSku, uom: 'm', quantity: { formulaKey: 'cable_m' }, when: [], order: 3 },
          ],
        },
      })

      const quoteId = await createQuote(request, token, cleanup, { customerEntityId: customerId })
      const opened = await openSession(request, token, { quoteId, modelId: model.modelId })
      expect(opened.status()).toBe(201)
      const openBody = await readJsonSafe<{ sessionId: string; revision: number; modelVersion: { id: string; hash: string }; quote: { id: string; number: string | null } }>(opened)
      expect(openBody).toMatchObject({ revision: 0, modelVersion: { id: model.modelVersionId, hash: model.hash }, quote: { id: quoteId } })
      expect(openBody?.quote.number).toBeTruthy()
      const sessionId = openBody?.sessionId ?? ''
      cleanup.add(() => cancelSession(request, token, sessionId))

      const fresh = await readSession(request, token, `id=${sessionId}`)
      expect(fresh.status()).toBe(200)
      expect(await readJsonSafe(fresh)).toMatchObject({ status: 'open', mode: 'new', revision: 0, quoteId, selections: {}, evaluation: null })

      const defaults = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: {} })
      expect(defaults.revision, 'evaluating the stored (empty) choices is no change').toBe(0)
      expect(defaults.evaluation.bom.map((line) => [line.bomId, line.sku, line.quantity, line.unitPrice, line.total])).toEqual([
        ['frame', frameSku, '1', '80', '80.00'],
        ['panel', blueSku, '2', '45.5', '91.00'],
        ['cable', cableSku, '0.5', '12.3456', '6.17'],
      ])
      expect(defaults.evaluation.bom[1].label).toBe(`Blue panel ${suffix}`)
      expect(defaults.evaluation.netPrice).toBe('177.17')
      expect(defaults.evaluation.finalisable).toBe(true)
      expect(defaults.evaluation.summary).toBe('Cable length: 0.5 m')
      expect(defaults.evaluation.priceContext).toMatchObject({ customerId, channelId: null })
      expect(defaults.evaluation.priceContext.customerGroupIds).toContain(groupId)

      const long = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: { length: 12 } })
      expect(long.revision).toBe(1)
      expect(long.evaluation.bom[2]).toMatchObject({ quantity: '12', unitPrice: '9', total: '108.00' })
      expect(long.evaluation.netPrice).toBe('279.00')
      expect(long.evaluation.hash).not.toBe(defaults.evaluation.hash)

      const stored = await readSession(request, token, `id=${sessionId}`)
      expect(await readJsonSafe(stored)).toMatchObject({
        revision: 1,
        selections: { length: 12 },
        evaluation: { netPrice: '279.00', hash: long.evaluation.hash },
        modelVersion: { id: model.modelVersionId, modelId: model.modelId, modelTitle: `QA PCFG 020 ${suffix}` },
      })

      const otherQuoteId = await createQuote(request, token, cleanup)
      const otherSessionId = await openSessionId(request, token, cleanup, { quoteId: otherQuoteId, modelId: model.modelId })
      const base = await evaluateOk(request, token, { id: otherSessionId, revision: 0, selections: {} })
      expect(base.evaluation.bom[0]).toMatchObject({ bomId: 'frame', unitPrice: '100', total: '100.00' })
      expect(base.evaluation.netPrice).toBe('197.17')
      expect(base.evaluation.priceContext.customerGroupIds).not.toContain(groupId)
    } finally {
      await deleteCustomerGroupMembershipIfExists(request, token, membershipId)
      await cleanup.run()
      await deleteCustomerGroupIfExists(request, token, groupId)
    }
  })
})
