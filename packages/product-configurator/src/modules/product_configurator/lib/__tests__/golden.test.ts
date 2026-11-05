import { definitionSchema, type ConfigurationDefinitionInput } from '../../data/validators'
import { evaluatePrice } from '../evaluator/price'
import { currencyExponent } from '../money'
import { buildReferenceDefinition, REFERENCE_PARTS } from '../referenceModel'
import { buildSummary } from '../summary'
import { validateForPublication } from '../validation'
import { PRICE_KIND_ID, structureOf } from './fixtures'
import { catalogItem, fakeCatalog, PRODUCT_ID } from './validationFixtures'

// Expected values below are worked out by hand from the reference definition, not from the engine:
// hose_m = boom * 2 + 0.5, so 20.5 m for the 10 m boom and 28.5 m for the 14 m boom. The spare hose
// adds 5 m of the same SKU. The force rule turns on auxiliary hydraulics when hose_m > 25.

function referenceDefinition(currencyCode = 'USD', mutate?: (input: ConfigurationDefinitionInput) => void) {
  const input = buildReferenceDefinition({ currencyCode, priceKindId: PRICE_KIND_ID })
  mutate?.(input)
  return definitionSchema.parse(input)
}

function evaluate(currencyCode: string, selections: Record<string, string | boolean>, unitPrices: Record<string, string>) {
  const definition = referenceDefinition(currencyCode)
  const structure = structureOf(definition, selections)
  const priced = evaluatePrice({ structure, unitPrices, currencyExponent: currencyExponent(currencyCode) })
  return { definition, structure, priced }
}

function summaryOf(definition = referenceDefinition(), selections: Record<string, string | boolean> = {}) {
  const structure = structureOf(definition, selections)
  return buildSummary({ definition, selections: structure.selections, visibility: structure.visibility, locale: 'en' })
}

function totals(priced: ReturnType<typeof evaluatePrice>) {
  return priced.bom.map((line) => [line.bomId, line.sku, line.quantity, line.total])
}

const USD_PRICES = Object.fromEntries(REFERENCE_PARTS.map((part) => [part.sku, part.unitPriceNet]))
const HOSE_TIER_1 = '7.4125'
const HOSE_TIER_2 = '6.9875'
const FULL_OPTIONS = { boom: '10', attachment: 'bucket', cab: 'enclosed', heater: true, aux_hydraulics: true }
const LONG_BOOM_HIDDEN_HEATER = { boom: '14', heater: true }

describe('golden values on the reference telehandler', () => {
  it('passes every publication check, so the seeded model can be published', async () => {
    const items = Object.fromEntries(REFERENCE_PARTS.map((part) => [part.sku, catalogItem(part.sku, part.unit)]))
    const report = await validateForPublication({
      definition: buildReferenceDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID }),
      productId: PRODUCT_ID,
      catalog: fakeCatalog({ items }).port,
    })
    expect(report).toEqual({ ok: true, issues: [] })
  })

  it('prices the defaults (USD)', () => {
    // chassis 41250.0000 x 1 = 41250.00; boom 10 m 6400.0000 x 1 = 6400.00; forks 1180.0000 x 1 = 1180.00
    // net = 41250.00 + 6400.00 + 1180.00 = 48830.00
    const { structure, priced } = evaluate('USD', {}, USD_PRICES)
    expect(structure.forced).toEqual([])
    expect(totals(priced)).toEqual([
      ['chassis', 'TH-CHASSIS', '1', '41250.00'],
      ['boom', 'TH-BOOM-10', '1', '6400.00'],
      ['attachment', 'TH-ATT-FORKS', '1', '1180.00'],
    ])
    expect(priced.netPrice).toBe('48830.00')
  })

  it('keeps sub-cent catalog prices until each line is rounded, with the repeated hose below the tier boundary (USD)', () => {
    // hose total = 20.5 + 5 = 25.5 m, below the 30 m tier, so the tier-1 price 7.4125 applies
    // heater 412.3350 -> 412.34 (half-up); hose 7.4125 x 20.5 = 151.95625 -> 151.96; spare 7.4125 x 5 = 37.0625 -> 37.06
    // net = 41250.00 + 6400.00 + 1625.75 + 3990.00 + 412.34 + 845.00 + 151.96 + 37.06 = 54712.11
    const { structure, priced } = evaluate('USD', FULL_OPTIONS, { ...USD_PRICES, 'TH-HOSE-M': HOSE_TIER_1 })
    expect(structure.calculated).toEqual({ hose_m: 20.5, rated_load_kg: 3500 })
    expect(structure.warnings).toEqual([])
    expect(totals(priced)).toEqual([
      ['chassis', 'TH-CHASSIS', '1', '41250.00'],
      ['boom', 'TH-BOOM-10', '1', '6400.00'],
      ['attachment', 'TH-ATT-BUCKET', '1', '1625.75'],
      ['cab', 'TH-CAB-ENCL', '1', '3990.00'],
      ['heater', 'TH-HEATER', '1', '412.34'],
      ['aux_valve', 'TH-AUX-VALVE', '1', '845.00'],
      ['aux_hose', 'TH-HOSE-M', '20.5', '151.96'],
      ['spare_hose', 'TH-HOSE-M', '5', '37.06'],
    ])
    expect(priced.skuQuantities.find((entry) => entry.sku === 'TH-HOSE-M')).toEqual({ sku: 'TH-HOSE-M', quantity: '25.5' })
    expect(priced.netPrice).toBe('54712.11')
  })

  it('forces auxiliary hydraulics from a calculated condition, hides the heater and crosses the hose tier (USD)', () => {
    // hose_m = 14 x 2 + 0.5 = 28.5 > 25, so F-LONG-BOOM-HYDRAULICS sets aux_hydraulics to true
    // the cab stays open, so the heater is hidden and falls back to its default (false): no heater line
    // hose total = 28.5 + 5 = 33.5 m, above the 30 m tier, so the tier-2 price 6.9875 applies
    // hose 6.9875 x 28.5 = 199.14375 -> 199.14; spare 6.9875 x 5 = 34.9375 -> 34.94
    // net = 41250.00 + 9150.50 + 1180.00 + 845.00 + 199.14 + 34.94 = 52659.58
    const { structure, priced } = evaluate('USD', LONG_BOOM_HIDDEN_HEATER, { ...USD_PRICES, 'TH-HOSE-M': HOSE_TIER_2 })
    expect(structure.forced).toEqual([
      { featureKey: 'aux_hydraulics', ruleId: 'F-LONG-BOOM-HYDRAULICS', from: false, to: true },
    ])
    expect(structure.visibility.heater).toBe(false)
    expect(structure.selections.heater).toBe(false)
    expect(totals(priced)).toEqual([
      ['chassis', 'TH-CHASSIS', '1', '41250.00'],
      ['boom', 'TH-BOOM-14', '1', '9150.50'],
      ['attachment', 'TH-ATT-FORKS', '1', '1180.00'],
      ['aux_valve', 'TH-AUX-VALVE', '1', '845.00'],
      ['aux_hose', 'TH-HOSE-M', '28.5', '199.14'],
      ['spare_hose', 'TH-HOSE-M', '5', '34.94'],
    ])
    expect(priced.skuQuantities.find((entry) => entry.sku === 'TH-HOSE-M')).toEqual({ sku: 'TH-HOSE-M', quantity: '33.5' })
    expect(priced.netPrice).toBe('52659.58')
  })

  it('reads the rated load lookup in a warning when the bucket goes on the long boom', () => {
    // rated_load_kg = 3000 for the 14 m boom, below 3200, and the attachment is the bucket
    const { structure } = evaluate('USD', { boom: '14', attachment: 'bucket' }, { ...USD_PRICES, 'TH-HOSE-M': HOSE_TIER_2 })
    expect(structure.warnings).toEqual([
      { ruleId: 'W-BUCKET-LOAD', params: { 'feature.attachment': 'bucket', 'lookup.rated_load': 3000 } },
    ])
  })

  it('rounds every line to whole yen (JPY, 0 decimals)', () => {
    // bucket 243862.5000 -> 243863; heater 61850.4999 -> 61850
    // hose 1111.8750 x 20.5 = 22793.4375 -> 22793; spare 1111.8750 x 5 = 5559.375 -> 5559
    // net = 6187500 + 960000 + 243863 + 598500 + 61850 + 126750 + 22793 + 5559 = 8206815
    const { priced } = evaluate('JPY', FULL_OPTIONS, {
      'TH-CHASSIS': '6187500.0000',
      'TH-BOOM-10': '960000.0000',
      'TH-ATT-BUCKET': '243862.5000',
      'TH-CAB-ENCL': '598500.0000',
      'TH-HEATER': '61850.4999',
      'TH-AUX-VALVE': '126750.0000',
      'TH-HOSE-M': '1111.8750',
    })
    expect(priced.currencyExponent).toBe(0)
    expect(priced.bom.map((line) => line.total)).toEqual(['6187500', '960000', '243863', '598500', '61850', '126750', '22793', '5559'])
    expect(priced.netPrice).toBe('8206815')
  })

  it('rounds every line to three decimals (KWD)', () => {
    // boom 14 m 2806.2505 -> 2806.251; valve 259.1255 -> 259.126
    // hose 2.1435 x 28.5 = 61.08975 -> 61.090; spare 2.1435 x 5 = 10.7175 -> 10.718
    // net = 12650.000 + 2806.251 + 361.875 + 259.126 + 61.090 + 10.718 = 16149.060
    const { priced } = evaluate('KWD', LONG_BOOM_HIDDEN_HEATER, {
      'TH-CHASSIS': '12650.0000',
      'TH-BOOM-14': '2806.2505',
      'TH-ATT-FORKS': '361.8750',
      'TH-AUX-VALVE': '259.1255',
      'TH-HOSE-M': '2.1435',
    })
    expect(priced.currencyExponent).toBe(3)
    expect(priced.bom.map((line) => line.total)).toEqual(['12650.000', '2806.251', '361.875', '259.126', '61.090', '10.718'])
    expect(priced.netPrice).toBe('16149.060')
  })
})

describe('summary of the reference telehandler', () => {
  it('follows feature order with units and leaves out false booleans and features outside the summary', () => {
    expect(summaryOf()).toBe('Boom length: 10 m; Attachment: Pallet forks; Cab: Open ROPS canopy')
  })

  it('shows true booleans as their label', () => {
    expect(summaryOf(referenceDefinition(), FULL_OPTIONS)).toBe(
      'Boom length: 10 m; Attachment: General-purpose bucket; Cab: Enclosed cab; Cab heater; Auxiliary hydraulics',
    )
  })

  it('shows a forced boolean and leaves out a hidden one', () => {
    expect(summaryOf(referenceDefinition(), LONG_BOOM_HIDDEN_HEATER)).toBe(
      'Boom length: 14 m; Attachment: Pallet forks; Cab: Open ROPS canopy; Auxiliary hydraulics',
    )
  })

  it('cuts at 1000 characters after the last whole entry', () => {
    // "Boom length: 10 m" is 17 characters and "; Attachment: " adds 14
    // a 969-character label gives exactly 17 + 14 + 969 = 1000, so the entry stays and the next one is cut
    // a 970-character label gives 1001, so the summary stops after the boom
    const withAttachmentLabel = (length: number) =>
      referenceDefinition('USD', (input) => {
        const attachment = input.features.find((feature) => feature.key === 'attachment')
        const forks = attachment?.options?.find((option) => option.value === 'forks')
        if (forks) forks.label = 'x'.repeat(length)
      })
    const atLimit = summaryOf(withAttachmentLabel(969))
    expect(atLimit).toBe(`Boom length: 10 m; Attachment: ${'x'.repeat(969)}`)
    expect(atLimit).toHaveLength(1000)
    expect(summaryOf(withAttachmentLabel(970))).toBe('Boom length: 10 m')
  })
})
