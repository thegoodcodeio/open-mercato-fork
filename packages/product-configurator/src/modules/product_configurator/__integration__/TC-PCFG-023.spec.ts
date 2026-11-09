import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './helpers/fixtures'
import {
  Cleanup,
  createPrice,
  createPriceKind,
  createProduct,
  createPublishedModel,
  createQuote,
  evaluateOk,
  evaluateSession,
  openSessionId,
} from './helpers/sessions'

function definition(frameSku: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    fixedSpecification: [],
    features: [
      {
        key: 'size',
        label: 'Size',
        type: 'choice',
        options: [
          { value: 's', label: 'Small', order: 1 },
          { value: 'l', label: 'Large', order: 2 },
        ],
        default: 's',
        order: 1,
        inSummary: true,
      },
      {
        key: 'color',
        label: 'Color',
        type: 'choice',
        options: [
          { value: 'red', label: 'Red', order: 1 },
          { value: 'blue', label: 'Blue', order: 2 },
        ],
        optionsFromLookup: 'colors_by_size',
        default: 'red',
        order: 2,
        inSummary: true,
      },
      { key: 'width', label: 'Width', type: 'number', min: 1, max: 3, step: 1, default: 1, order: 3, inSummary: false },
    ],
    rules: [],
    formulas: [],
    lookups: [
      {
        kind: 'permitted',
        key: 'colors_by_size',
        keyedBy: 'size',
        rows: [
          { match: 's', values: ['red', 'blue'], default: 'red' },
          { match: 'l', values: ['red'], default: 'red' },
        ],
      },
      {
        kind: 'value',
        key: 'frame_by_width',
        keyedBy: 'width',
        rows: [
          { match: '1', value: frameSku },
          { match: '2', value: frameSku },
        ],
      },
    ],
    bom: [{ id: 'frame', skuFromLookup: { lookupKey: 'frame_by_width', keyedBy: 'width' }, uom: 'pc', quantity: 1, when: [], order: 1 }],
  }
}

test.describe('TC-PCFG-023: invalid and disallowed selections', () => {
  test('an invalid selection answers 422; a value outside the permitted row and a lookup gap are blocking errors', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const cleanup = new Cleanup()

    try {
      const productId = await createProduct(request, token, cleanup, { title: `QA PCFG 023 ${suffix}`, sku: `QA-PCFG-023-${suffix}` })
      const frameSku = `QA-PCFG-023-FRAME-${suffix}`
      const frameId = await createProduct(request, token, cleanup, { title: `QA PCFG 023 frame ${suffix}`, sku: frameSku })
      const priceKindId = await createPriceKind(request, token, cleanup)
      await createPrice(request, token, cleanup, { productId: frameId, priceKindId, unitPriceNet: '50.00' })
      const model = await createPublishedModel(request, token, cleanup, { productId, priceKindId, definition: definition(frameSku) })
      const quoteId = await createQuote(request, token, cleanup)
      const sessionId = await openSessionId(request, token, cleanup, { quoteId, modelId: model.modelId })

      const notAnOption = await evaluateSession(request, token, { id: sessionId, revision: 0, selections: { size: 'xl' } })
      expect(notAnOption.status()).toBe(422)
      const notAnOptionBody = await readJsonSafe<{ code: string; issues: Array<{ featureKey: string; reason: string }> }>(notAnOption)
      expect(notAnOptionBody?.code).toBe('invalid_selection')
      expect(notAnOptionBody?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ featureKey: 'size', reason: 'not_an_option' })]))

      const outOfRange = await evaluateSession(request, token, { id: sessionId, revision: 0, selections: { width: 9 } })
      expect(outOfRange.status()).toBe(422)
      expect((await readJsonSafe<{ code: string }>(outOfRange))?.code).toBe('invalid_selection')
      const unknownFeature = await evaluateSession(request, token, { id: sessionId, revision: 0, selections: { voltage: 400 } })
      expect(unknownFeature.status()).toBe(422)

      const disallowed = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: { size: 'l', color: 'blue' } })
      expect(disallowed.revision, 'a 422 stored nothing, so the revision only moves now').toBe(1)
      expect(disallowed.evaluation.finalisable).toBe(false)
      expect(disallowed.evaluation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'option_not_available', params: expect.objectContaining({ featureKey: 'color' }) })]),
      )

      const gap = await evaluateOk(request, token, { id: sessionId, revision: 1, selections: { width: 3 } })
      expect(gap.evaluation.finalisable).toBe(false)
      expect(gap.evaluation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'bom_sku_unmapped', params: expect.objectContaining({ bomId: 'frame', featureKey: 'width', value: '3' }) })]),
      )
      expect(gap.evaluation.bom).toEqual([])

      const valid = await evaluateOk(request, token, { id: sessionId, revision: 2, selections: { size: 's', color: 'blue', width: 2 } })
      expect(valid.evaluation.finalisable).toBe(true)
      expect(valid.evaluation.netPrice).toBe('50.00')
    } finally {
      await cleanup.run()
    }
  })
})
