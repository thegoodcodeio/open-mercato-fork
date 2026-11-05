import { validateForPublication } from '../validation'
import { PRICE_KIND_ID, referenceInput } from './fixtures'
import { catalogItem, codesOf, fakeCatalog, PRODUCT_ID, validate } from './validationFixtures'

describe('validateForPublication: catalog checks', () => {
  it('reports a missing bound product and unknown SKUs from fixed lines and SKU lookups', async () => {
    const report = await validate(undefined, { productMissing: true, items: { 'PUMP-BASE': null, 'MOTOR-HD': null } })
    expect(report.issues).toEqual([
      { check: 'referential_integrity', code: 'product_missing', params: { productId: PRODUCT_ID }, refs: [{ kind: 'product', key: PRODUCT_ID }] },
      { check: 'referential_integrity', code: 'unknown_sku', params: { sku: 'PUMP-BASE' }, refs: [{ kind: 'bom', key: 'base' }] },
      {
        check: 'referential_integrity',
        code: 'unknown_sku',
        params: { sku: 'MOTOR-HD' },
        refs: [{ kind: 'bom', key: 'motor' }, { kind: 'lookup', key: 'motor_skus' }],
      },
    ])
  })

  it('reports a SKU found as both product and variant as ambiguous_sku', async () => {
    const report = await validate(undefined, { ambiguous: ['PIPE-M'] })
    expect(report.issues).toEqual([
      {
        check: 'ambiguous_sku',
        code: 'ambiguous_sku',
        params: { sku: 'PIPE-M' },
        refs: [{ kind: 'bom', key: 'pipe' }, { kind: 'bom', key: 'pipe_extra' }],
      },
    ])
  })

  it('reports a BOM unit different from the catalog base unit, a missing unit and a sales unit quantity other than 1', async () => {
    const report = await validate(undefined, {
      items: {
        'PIPE-M': catalogItem('PIPE-M', 'cm'),
        'MOTOR-HD': catalogItem('MOTOR-HD', null),
        'PUMP-BASE': catalogItem('PUMP-BASE', 'pcs', '2.0000'),
      },
    })
    expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
      ['bom_unit_mismatch', 'bom_sales_unit_quantity', { bomId: 'base', sku: 'PUMP-BASE', salesUnitQuantity: '2.0000' }],
      ['bom_unit_mismatch', 'bom_unit_missing', { bomId: 'motor', sku: 'MOTOR-HD' }],
      ['bom_unit_mismatch', 'bom_unit_mismatch', { bomId: 'pipe', sku: 'PIPE-M', uom: 'm', unit: 'cm' }],
      ['bom_unit_mismatch', 'bom_unit_mismatch', { bomId: 'pipe_extra', sku: 'PIPE-M', uom: 'm', unit: 'cm' }],
    ])
  })

  it('requires every SKU of a lookup line to share the line unit and accepts a sales unit quantity written as 1.0000', async () => {
    const mixed = await validate(undefined, { items: { 'MOTOR-HD': catalogItem('MOTOR-HD', 'set') } })
    expect(mixed.issues.map((issue) => issue.params)).toEqual([{ bomId: 'motor', sku: 'MOTOR-HD', uom: 'pcs', unit: 'set' }])
    expect((await validate(undefined, { items: { 'MOTOR-HD': catalogItem('MOTOR-HD', 'pcs', '1.0000') } })).ok).toBe(true)
  })

  it('reports a price kind the catalog does not return', async () => {
    const report = await validate(undefined, { priceKindMissing: true })
    expect(report.issues).toEqual([
      { check: 'price_kind', code: 'price_kind_missing', params: { priceKindId: PRICE_KIND_ID }, refs: [{ kind: 'priceKind', key: PRICE_KIND_ID }] },
    ])
  })

  it('resolves SKUs in chunks of at most 500', async () => {
    const input = referenceInput()
    const rows = Array.from({ length: 600 }, (_, index) => ({ match: String(index + 1), value: `PART-${index}` }))
    input.features[1] = { ...input.features[1], min: 1, max: 600, step: 1 }
    input.lookups.push({ kind: 'value', key: 'parts', keyedBy: 'length', rows })
    input.bom.push({ id: 'part', skuFromLookup: { lookupKey: 'parts', keyedBy: 'length' }, uom: 'pcs', quantity: 1, when: [], order: 9 })
    const { port, resolveSkus } = fakeCatalog({ items: Object.fromEntries(rows.map((row) => [row.value, catalogItem(row.value, 'pcs')])) })

    const report = await validateForPublication({ definition: input, productId: PRODUCT_ID, catalog: port })

    expect(codesOf(report)).toEqual([])
    expect(resolveSkus.mock.calls.map(([skus]) => skus.length)).toEqual([500, 104])
  })
})
