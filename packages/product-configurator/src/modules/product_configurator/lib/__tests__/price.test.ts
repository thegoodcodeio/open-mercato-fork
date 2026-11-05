import { createHash } from 'node:crypto'
import { ConfiguratorEvaluationError } from '../evaluator/errors'
import { evaluatePrice, totalQuantitiesBySku } from '../evaluator/price'
import type { StructureResult } from '../evaluator/types'
import { canonicalJson, hashDefinition } from '../hash'
import { currencyExponent } from '../money'
import { build, parseDefinition, PRICE_KIND_ID, REFERENCE_PRICES, structureOf, VERSION_HASH, VERSION_ID } from './fixtures'

function price(structure: StructureResult, unitPrices: Record<string, string> = REFERENCE_PRICES) {
  return evaluatePrice({ structure, unitPrices, currencyExponent: currencyExponent(structure.currencyCode) })
}

function withCurrency(currencyCode: string) {
  return build((input) => {
    input.commercial.currencyCode = currencyCode
  })
}

function partsDefinition(lines: { id: string; sku: string; quantity: number }[]) {
  return build((input) => {
    input.formulas = []
    input.bom = lines.map((line, index) => ({ ...line, uom: 'pcs', when: [], order: index + 1 }))
  })
}

describe('evaluatePrice', () => {
  it('rounds each line once to the currency exponent and sums the rounded lines (EUR)', () => {
    const result = price(structureOf(build()))
    expect(result.bom.map(({ bomId, unitPrice, total }) => ({ bomId, unitPrice, total }))).toEqual([
      { bomId: 'base', unitPrice: '1000', total: '1000.00' },
      { bomId: 'motor', unitPrice: '250.505', total: '250.51' },
      { bomId: 'pipe', unitPrice: '12.3456', total: '27.78' },
    ])
    expect(result.netPrice).toBe('1278.29')
    expect(result.currencyExponent).toBe(2)
  })

  it('sums a repeated SKU across BOM lines into one total quantity', () => {
    const structure = structureOf(build(), { cover: true })
    expect(totalQuantitiesBySku(structure.bom)).toEqual([
      { sku: 'PUMP-BASE', quantity: '1' },
      { sku: 'MOTOR-STD', quantity: '1' },
      { sku: 'PIPE-M', quantity: '3.25' },
    ])
    const result = price(structure)
    expect(result.skuQuantities).toEqual(totalQuantitiesBySku(structure.bom))
    expect(result.bom.filter((line) => line.sku === 'PIPE-M').map((line) => line.total)).toEqual(['27.78', '12.35'])
    expect(result.netPrice).toBe('1290.64')
  })

  it('rounds half-up per line, not on the sum', () => {
    const structure = structureOf(
      partsDefinition([
        { id: 'first', sku: 'TINY', quantity: 1 },
        { id: 'second', sku: 'TINY', quantity: 1 },
      ]),
    )
    const result = price(structure, { TINY: '0.0050' })
    expect(result.bom.map((line) => line.total)).toEqual(['0.01', '0.01'])
    expect(result.netPrice).toBe('0.02')
  })

  it('keeps sub-cent catalog prices until the line total is rounded', () => {
    const structure = structureOf(partsDefinition([{ id: 'washer', sku: 'WASHER', quantity: 3 }]))
    expect(price(structure, { WASHER: '0.0125' }).netPrice).toBe('0.04')
    expect(price(structure, { WASHER: '0.0116' }).netPrice).toBe('0.03')
  })

  it('prices a fractional quantity below one with its real quantity', () => {
    const structure = structureOf(partsDefinition([{ id: 'hose', sku: 'HOSE-M', quantity: 0.5 }]))
    const result = price(structure, { 'HOSE-M': '10.0000' })
    expect(result.skuQuantities).toEqual([{ sku: 'HOSE-M', quantity: '0.5' }])
    expect(result.netPrice).toBe('5.00')
  })

  it('rounds to whole units for a 0-decimal currency (JPY)', () => {
    const result = price(structureOf(withCurrency('JPY')), {
      'PUMP-BASE': '1000.5000',
      'MOTOR-STD': '250.4999',
      'PIPE-M': '12.3456',
    })
    expect(result.currencyExponent).toBe(0)
    expect(result.bom.map((line) => line.total)).toEqual(['1001', '250', '28'])
    expect(result.netPrice).toBe('1279')
  })

  it('rounds to three decimals for KWD and BHD', () => {
    const prices = { 'PUMP-BASE': '1000.0005', 'MOTOR-STD': '250.5050', 'PIPE-M': '12.3456' }
    const kwd = price(structureOf(withCurrency('KWD')), prices)
    expect(kwd.currencyExponent).toBe(3)
    expect(kwd.bom.map((line) => line.total)).toEqual(['1000.001', '250.505', '27.778'])
    expect(kwd.netPrice).toBe('1278.284')
    expect(price(structureOf(withCurrency('BHD')), prices).netPrice).toBe('1278.284')
  })

  it('fails with price_missing for SKUs without a unit price', () => {
    const prices: Record<string, string> = { ...REFERENCE_PRICES }
    delete prices['MOTOR-STD']
    let caught: unknown
    try {
      price(structureOf(build()), prices)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfiguratorEvaluationError)
    if (caught instanceof ConfiguratorEvaluationError) {
      expect(caught.code).toBe('price_missing')
      expect(caught.params).toEqual({ skus: ['MOTOR-STD'] })
    }
  })
})

describe('evaluatePrice: SKUs named like Object.prototype members', () => {
  it('reports a missing unit price for SKU "constructor" instead of reading an inherited member', () => {
    let caught: unknown
    try {
      price(structureOf(partsDefinition([{ id: 'odd', sku: 'constructor', quantity: 1 }])), {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfiguratorEvaluationError)
    expect(caught).toMatchObject({ code: 'price_missing', params: { skus: ['constructor'] } })
  })
})

describe('configuration hash', () => {
  it('is sha256 of the canonical payload with scaled integers', () => {
    const definition = parseDefinition({
      schemaVersion: 1,
      commercial: { currencyCode: 'EUR', priceKindId: PRICE_KIND_ID },
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
      ],
      rules: [],
      formulas: [],
      lookups: [],
      bom: [{ id: 'part', sku: 'PART', uom: 'pcs', quantity: 1.5, when: [], order: 1 }],
    })
    const result = price(structureOf(definition), { PART: '10.0050' })
    const expected =
      '{"bom":[{"quantity":"1500000","sku":"PART","total":"1501","unitPrice":"100050"}],"calculated":{},' +
      `"currencyCode":"EUR","errors":[],"forced":[],"modelVersionHash":"${VERSION_HASH}",` +
      `"modelVersionId":"${VERSION_ID}","priceKindId":"${PRICE_KIND_ID}","selections":{"size":"s"},"warnings":[]}`
    expect(result.netPrice).toBe('15.01')
    expect(result.hash).toBe(createHash('sha256').update(expected).digest('hex'))
  })

  it('is stable for the same input, selection key order and a stored-and-reloaded structure', () => {
    const first = price(structureOf(build(), { motor: 'heavy', seal: 'viton', length: 4 }))
    const reordered = price(structureOf(build(), { length: 4, seal: 'viton', motor: 'heavy' }))
    const reloaded = price(JSON.parse(JSON.stringify(structureOf(build(), { motor: 'heavy', seal: 'viton', length: 4 }))))
    expect(reordered.hash).toBe(first.hash)
    expect(reloaded.hash).toBe(first.hash)
  })

  it('does not change with message copy', () => {
    const withWarning = (template: string) =>
      build((input) => {
        input.rules = [
          {
            id: 'W-INFO',
            effect: 'warning',
            when: [],
            messageTemplate: template,
            featureKeys: [],
            order: 1,
          },
        ]
      })
    const original = withWarning('Weight is {formula.weight} kg')
    const reworded = withWarning('The pump weighs {formula.weight} kg in total')
    expect(price(structureOf(reworded)).hash).toBe(price(structureOf(original)).hash)
  })

  it('changes when prices, selections or the model version change', () => {
    const base = price(structureOf(build()))
    expect(price(structureOf(build()), { ...REFERENCE_PRICES, 'PIPE-M': '12.3457' }).hash).not.toBe(base.hash)
    expect(price(structureOf(build(), { color: 'blue' })).hash).not.toBe(base.hash)
    const otherVersion = { ...structureOf(build()), modelVersionHash: 'b'.repeat(64) }
    expect(price(otherVersion).hash).not.toBe(base.hash)
  })

  it('builds canonical JSON with sorted keys, kept array order and dropped undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, skipped: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    )
    const definition = build()
    expect(hashDefinition(definition)).toBe(createHash('sha256').update(canonicalJson(definition)).digest('hex'))
  })
})
