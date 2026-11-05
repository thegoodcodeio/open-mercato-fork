import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createVariantFixture, deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  VALIDATE_PATH,
  buildDefinition,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  uniqueSuffix,
} from './helpers/fixtures'

type Report = { ok: boolean; issues: Array<{ check: string; code: string }> }

function brokenDefinition(input: { priceKindId: string; partSku: string; sharedSku: string; unknownSku: string }) {
  const sizeOptions = [
    { value: 's', label: 'Small', order: 1 },
    { value: 'l', label: 'Large', order: 2 },
  ]
  return {
    schemaVersion: 1,
    commercial: { currencyCode: 'EUR', priceKindId: input.priceKindId, allowPromotions: false },
    fixedSpecification: [],
    features: [
      { key: 'size', label: 'Size', type: 'choice', options: sizeOptions, default: 's', order: 1, inSummary: true },
      {
        key: 'flag',
        label: 'Flag',
        type: 'choice',
        options: [
          { value: 'a', label: 'A', order: 1 },
          { value: 'b', label: 'B', order: 2 },
        ],
        default: 'a',
        order: 2,
        inSummary: false,
      },
      { key: 'height', label: 'Height', type: 'number', min: 1, max: 10, default: 50, order: 3, inSummary: false },
      { key: 'dup', label: 'Duplicate 1', type: 'boolean', default: false, order: 4, inSummary: false },
      { key: 'dup', label: 'Duplicate 2', type: 'boolean', default: false, order: 5, inSummary: false },
    ],
    rules: [
      {
        id: 'flip',
        effect: 'force',
        when: [],
        action: { kind: 'map', featureKey: 'flag', from: { a: 'b', b: 'a' } },
        messageTemplate: '',
        featureKeys: ['flag'],
        order: 1,
      },
    ],
    formulas: [
      { key: 'loop_a', expr: { kind: 'formula', formulaKey: 'loop_b' } },
      { key: 'loop_b', expr: { kind: 'formula', formulaKey: 'loop_a' } },
    ],
    lookups: [{ kind: 'value', key: 'parts', keyedBy: 'size', rows: [{ match: 's', value: input.partSku }] }],
    bom: [
      { id: 'unknown', sku: input.unknownSku, uom: 'pc', quantity: 1, when: [], order: 1 },
      { id: 'shared', sku: input.sharedSku, uom: 'pc', quantity: 1, when: [], order: 2 },
      { id: 'meters', sku: input.partSku, uom: 'm', quantity: 1, when: [], order: 3 },
      { id: 'by_size', skuFromLookup: { lookupKey: 'parts', keyedBy: 'size' }, uom: 'pc', quantity: 1, when: [], order: 4 },
    ],
  }
}

test.describe('TC-PCFG-002: publication checks report the right codes', () => {
  test('validate lists every broken rule of a draft and the limit of an oversized one', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-002-PART-${suffix}`
    const sharedSku = `QA-PCFG-002-SHARED-${suffix}`
    const productIds: string[] = []
    const modelIds: string[] = []
    let priceKindId: string | null = null

    try {
      const boundProductId = await createUnitProductFixture(request, token, { title: `QA PCFG 002 ${suffix}`, sku: `QA-PCFG-002-${suffix}` })
      productIds.push(boundProductId)
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 002 part ${suffix}`, sku: partSku }))
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 002 shared ${suffix}`, sku: sharedSku }))
      const variantParentId = await createUnitProductFixture(request, token, {
        title: `QA PCFG 002 variant parent ${suffix}`,
        sku: `QA-PCFG-002-PARENT-${suffix}`,
      })
      productIds.push(variantParentId)
      await createVariantFixture(request, token, { productId: variantParentId, name: 'Shared SKU variant', sku: sharedSku })
      priceKindId = await createPriceKindFixture(request, token)

      const brokenId = await createModelFixture(request, token, {
        productId: boundProductId,
        priceKindId,
        draftDefinition: brokenDefinition({ priceKindId, partSku, sharedSku, unknownSku: `QA-PCFG-002-NOPE-${suffix}` }),
      })
      modelIds.push(brokenId)

      const response = await apiRequest(request, 'POST', VALIDATE_PATH, { token, data: { id: brokenId } })
      expect(response.status()).toBe(200)
      const report = await readJsonSafe<Report>(response)
      expect(report?.ok).toBe(false)
      const codes = new Set((report?.issues ?? []).map((issue) => `${issue.check}/${issue.code}`))
      for (const expected of [
        'duplicate_key/duplicate_key',
        'formula_cycle/formula_cycle',
        'referential_integrity/unknown_sku',
        'ambiguous_sku/ambiguous_sku',
        'default_valid/default_out_of_bounds',
        'fixed_point/fixed_point_not_reached',
        'bom_unit_mismatch/bom_unit_mismatch',
        'lookup_coverage/lookup_row_missing',
      ]) {
        expect(codes, `report should contain ${expected}`).toContain(expected)
      }

      const oversized = buildDefinition({ priceKindId })
      oversized.features = Array.from({ length: 201 }, (_, index) => ({
        key: `f${index}`,
        label: `Feature ${index}`,
        type: 'boolean',
        default: false,
        order: index,
        inSummary: false,
      }))
      const oversizedId = await createModelFixture(request, token, { productId: boundProductId, priceKindId, draftDefinition: oversized })
      modelIds.push(oversizedId)

      const limitResponse = await apiRequest(request, 'POST', VALIDATE_PATH, { token, data: { id: oversizedId } })
      expect(limitResponse.status()).toBe(200)
      const limitReport = await readJsonSafe<Report>(limitResponse)
      expect(limitReport?.ok).toBe(false)
      expect(limitReport?.issues.map((issue) => `${issue.check}/${issue.code}`)).toContain('limits/limit_exceeded')
    } finally {
      for (const id of modelIds) await deleteModelIfExists(request, token, id)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
