import { TextEncoder } from 'node:util'
import { build } from '../../../lib/__tests__/fixtures'
import { BOM_ERROR_KEYS, formToLine, lineSkus, lineToForm, samePart, suggestBomId } from '../tabs/bom/bomForm'
import { resolveCatalogSkus, summarizeSkuUnits, type CatalogCache, type CatalogEntry } from '../tabs/bom/bomCatalog'

Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (url: string) => apiCallMock(url),
}))

describe('BOM row editor form', () => {
  const definition = build()

  it('round-trips every line of the reference model with its stored unit', () => {
    for (const line of definition.bom) {
      const otherIds = definition.bom.filter((entry) => entry.id !== line.id).map((entry) => entry.id)
      const result = formToLine(lineToForm(line, { id: 'x', order: 0 }), { otherIds, definition, uom: line.uom })
      expect(result).toEqual({ ok: true, line })
    }
  })

  it('takes keyedBy from the lookup and uom from the catalog, never from the form', () => {
    const values = { ...lineToForm(undefined, { id: 'motor_2', order: 50 }), partKind: 'lookup' as const, lookupKey: 'motor_skus' }
    const result = formToLine(values, { otherIds: [], definition, uom: 'pc' })
    expect(result).toEqual({
      ok: true,
      line: { id: 'motor_2', skuFromLookup: { lookupKey: 'motor_skus', keyedBy: 'motor' }, uom: 'pc', quantity: 1, when: [], order: 50 },
    })
  })

  it('builds a formula quantity and a surcharge binding', () => {
    const values = {
      ...lineToForm(undefined, { id: 'paint', order: 10 }),
      sku: ' PAINT-1 ',
      quantityKind: 'formula' as const,
      formulaKey: 'pipe_meters',
      ruleId: 'paint_rule',
    }
    const result = formToLine(values, { otherIds: [], definition, uom: 'm' })
    expect(result.ok && result.line).toEqual({
      id: 'paint',
      sku: 'PAINT-1',
      uom: 'm',
      quantity: { formulaKey: 'pipe_meters' },
      when: [],
      ruleId: 'paint_rule',
      order: 10,
    })
  })

  it('reports field errors instead of building an invalid line', () => {
    const values = { ...lineToForm(undefined, { id: 'base', order: 1 }), quantity: '-1', order: '1.5' }
    expect(formToLine(values, { otherIds: ['base'], definition, uom: null })).toEqual({
      ok: false,
      errors: { id: BOM_ERROR_KEYS.duplicateId, sku: BOM_ERROR_KEYS.required, quantity: BOM_ERROR_KEYS.quantity, order: BOM_ERROR_KEYS.integer },
    })
    const withSku = { ...lineToForm(undefined, { id: 'bad id', order: 1 }), sku: 'X' }
    expect(formToLine(withSku, { otherIds: [], definition, uom: null })).toEqual({
      ok: false,
      errors: { id: BOM_ERROR_KEYS.invalidId, unit: BOM_ERROR_KEYS.unitMissing },
    })
    const unknownLookup = { ...lineToForm(undefined, { id: 'l', order: 1 }), partKind: 'lookup' as const, lookupKey: 'seals_by_motor' }
    expect(formToLine(unknownLookup, { otherIds: [], definition, uom: 'pc' })).toEqual({
      ok: false,
      errors: { lookupKey: BOM_ERROR_KEYS.lookupMissing },
    })
  })

  it('reads quantity and order as plain decimal numbers only', () => {
    const base = { ...lineToForm(undefined, { id: 'n', order: 1 }), sku: 'X' }
    for (const raw of ['0x10', '', '   ', 'Infinity', '1,5']) {
      const result = formToLine({ ...base, quantity: raw, order: raw }, { otherIds: [], definition, uom: 'pc' })
      expect(result).toEqual({ ok: false, errors: { quantity: BOM_ERROR_KEYS.quantity, order: BOM_ERROR_KEYS.integer } })
    }
    const parsed = formToLine({ ...base, quantity: ' 2.5 ', order: '20' }, { otherIds: [], definition, uom: 'pc' })
    expect(parsed.ok && [parsed.line.quantity, parsed.line.order]).toEqual([2.5, 20])
  })

  it('lists the SKUs a line can resolve to and spots an unchanged part', () => {
    expect(lineSkus({ partKind: 'lookup', sku: '', lookupKey: 'motor_skus' }, definition)).toEqual(['MOTOR-STD', 'MOTOR-HD'])
    expect(lineSkus({ partKind: 'lookup', sku: '', lookupKey: 'seals_by_motor' }, definition)).toEqual([])
    expect(lineSkus({ partKind: 'sku', sku: '  ', lookupKey: '' }, definition)).toEqual([])
    const base = definition.bom[0]
    expect(samePart({ partKind: 'sku', sku: ' PUMP-BASE ', lookupKey: '' }, base)).toBe(true)
    expect(samePart({ partKind: 'sku', sku: 'OTHER', lookupKey: '' }, base)).toBe(false)
    expect(samePart({ partKind: 'sku', sku: 'PUMP-BASE', lookupKey: '' }, undefined)).toBe(false)
  })

  it('suggests the first free line id', () => {
    expect(suggestBomId(definition.bom)).toBe('line_5')
    expect(suggestBomId([{ ...definition.bom[0], id: 'line_2' }])).toBe('line_3')
  })
})

describe('BOM catalog units', () => {
  const found = (unit: string | null): CatalogEntry => ({ status: 'found', title: 'Item', unit })

  it('gives the common unit only when every found SKU has the same one', () => {
    const entries = new Map<string, CatalogEntry>([
      ['A', found('pc')],
      ['B', found('pc')],
      ['C', found('set')],
      ['D', found(null)],
      ['E', { status: 'unknown' }],
      ['F', { status: 'ambiguous' }],
    ])
    expect(summarizeSkuUnits(['A', 'B', 'E'], entries)).toMatchObject({ commonUnit: 'pc', unknown: ['E'] })
    expect(summarizeSkuUnits(['A', 'C'], entries)).toMatchObject({ commonUnit: null, units: [{ sku: 'A', unit: 'pc' }, { sku: 'C', unit: 'set' }] })
    expect(summarizeSkuUnits(['A', 'D'], entries)).toMatchObject({ commonUnit: null, missingUnit: ['D'] })
    expect(summarizeSkuUnits(['F'], entries)).toMatchObject({ commonUnit: null, ambiguous: ['F'] })
    expect(summarizeSkuUnits(['A', 'Z'], entries)).toMatchObject({ commonUnit: null, checking: true })
  })

  it('asks for at most 100 SKUs per request, once per SKU, and retries failed ones', async () => {
    apiCallMock.mockReset()
    apiCallMock.mockImplementation(async (url: string) => {
      const skus = decodeURIComponent(new URL(url, 'http://localhost').searchParams.get('skus') ?? '').split(',')
      return { ok: true, result: { items: skus.map((sku) => ({ sku, title: `Title ${sku}`, unit: 'pc' })), unknown: [], ambiguous: [] } }
    })
    const cache: CatalogCache = new Map()
    const skus = Array.from({ length: 150 }, (_, index) => `SKU-${index}`)
    const entries = await resolveCatalogSkus(skus, cache)
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    expect(entries.get('SKU-149')).toEqual({ status: 'found', title: 'Title SKU-149', unit: 'pc' })
    await resolveCatalogSkus(['SKU-1'], cache)
    expect(apiCallMock).toHaveBeenCalledTimes(2)

    apiCallMock.mockResolvedValueOnce({ ok: false, result: null })
    expect((await resolveCatalogSkus(['NEW'], cache)).get('NEW')).toEqual({ status: 'failed' })
    expect((await resolveCatalogSkus(['NEW'], cache)).get('NEW')).toMatchObject({ status: 'found' })
    expect(apiCallMock).toHaveBeenCalledTimes(4)
  })
})
