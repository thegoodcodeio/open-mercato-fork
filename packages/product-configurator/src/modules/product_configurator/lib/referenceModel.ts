import type { ConfigurationDefinitionInput } from '../data/validators'

export const REFERENCE_MODEL_KEY = 'telehandler-th3510'
export const REFERENCE_MODEL_TITLE = 'Telehandler TH-3510'
export const REFERENCE_MODEL_CURRENCY = 'USD'
export const REFERENCE_BOUND_PRODUCT = { sku: 'TH-3510', title: 'Telehandler TH-3510', unit: 'pc' } as const

export type ReferencePart = { sku: string; title: string; unit: 'pc' | 'm'; unitPriceNet: string }

export const REFERENCE_PARTS: readonly ReferencePart[] = [
  { sku: 'TH-CHASSIS', title: 'TH-3510 chassis with 75 kW engine', unit: 'pc', unitPriceNet: '41250.0000' },
  { sku: 'TH-BOOM-10', title: 'Telescopic boom 10 m', unit: 'pc', unitPriceNet: '6400.0000' },
  { sku: 'TH-BOOM-14', title: 'Telescopic boom 14 m', unit: 'pc', unitPriceNet: '9150.5000' },
  { sku: 'TH-ATT-FORKS', title: 'Pallet forks 1200 mm', unit: 'pc', unitPriceNet: '1180.0000' },
  { sku: 'TH-ATT-BUCKET', title: 'General-purpose bucket 1.5 m3', unit: 'pc', unitPriceNet: '1625.7500' },
  { sku: 'TH-CAB-ENCL', title: 'Enclosed cab', unit: 'pc', unitPriceNet: '3990.0000' },
  { sku: 'TH-HEATER', title: 'Cab heater', unit: 'pc', unitPriceNet: '412.3350' },
  { sku: 'TH-AUX-VALVE', title: 'Auxiliary hydraulic valve block', unit: 'pc', unitPriceNet: '845.0000' },
  { sku: 'TH-HOSE-M', title: 'Hydraulic hose', unit: 'm', unitPriceNet: '7.4125' },
]

/** A neutral reference model: an agricultural telehandler. Seeded as an example and used by the golden-value tests. */
export function buildReferenceDefinition(commercial: { currencyCode: string; priceKindId: string }): ConfigurationDefinitionInput {
  const isTrue = (featureKey: string) => ({ kind: 'compare' as const, featureKey, op: 'eq' as const, value: 'true' })
  return {
    schemaVersion: 1,
    commercial: { currencyCode: commercial.currencyCode, priceKindId: commercial.priceKindId, allowPromotions: false },
    fixedSpecification: [
      { label: 'Engine', value: '75 kW diesel' },
      { label: 'Drive', value: '4x4, four-wheel steering' },
    ],
    features: [
      {
        key: 'paint',
        label: 'Paint',
        type: 'color',
        options: [
          { value: 'yellow', label: 'Signal yellow', order: 1, swatch: '#F2B705' },
          { value: 'green', label: 'Farm green', order: 2, swatch: '#2E6B30' },
        ],
        default: 'yellow',
        order: 6,
        inSummary: false,
      },
      {
        key: 'boom',
        label: 'Boom length',
        type: 'choice',
        options: [
          { value: '10', label: '10', order: 1 },
          { value: '14', label: '14', order: 2 },
        ],
        unit: 'm',
        default: '10',
        order: 1,
        inSummary: true,
      },
      {
        key: 'attachment',
        label: 'Attachment',
        type: 'choice',
        options: [
          { value: 'forks', label: 'Pallet forks', order: 1 },
          { value: 'bucket', label: 'General-purpose bucket', order: 2 },
        ],
        default: 'forks',
        order: 2,
        inSummary: true,
      },
      { key: 'aux_hydraulics', label: 'Auxiliary hydraulics', type: 'boolean', default: false, order: 5, inSummary: true },
      {
        key: 'cab',
        label: 'Cab',
        type: 'choice',
        options: [
          { value: 'open', label: 'Open ROPS canopy', order: 1 },
          { value: 'enclosed', label: 'Enclosed cab', order: 2 },
        ],
        default: 'open',
        order: 3,
        inSummary: true,
      },
      {
        key: 'heater',
        label: 'Cab heater',
        type: 'boolean',
        default: false,
        order: 4,
        inSummary: true,
        visibleWhen: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }],
      },
    ],
    rules: [
      {
        id: 'F-LONG-BOOM-HYDRAULICS',
        label: 'Long hose runs need auxiliary hydraulics',
        effect: 'force',
        when: [{ kind: 'calculated', formulaKey: 'hose_m', op: 'gt', value: 25 }],
        action: { kind: 'set', featureKey: 'aux_hydraulics', value: true },
        messageTemplate: 'A boom with {formula.hose_m} m of hose comes with auxiliary hydraulics.',
        featureKeys: ['aux_hydraulics'],
        order: 1,
      },
      {
        id: 'W-BUCKET-LOAD',
        label: 'Reduced rated load with a bucket',
        effect: 'warning',
        when: [
          { kind: 'compare', featureKey: 'attachment', op: 'eq', value: 'bucket' },
          { kind: 'calculated', formulaKey: 'rated_load_kg', op: 'lt', value: 3200 },
        ],
        messageTemplate: 'The rated load with the {feature.attachment} on this boom is {lookup.rated_load} kg.',
        featureKeys: ['attachment', 'boom'],
        order: 2,
      },
    ],
    formulas: [
      {
        key: 'hose_m',
        label: 'Hydraulic hose length',
        expr: {
          kind: 'op',
          op: '+',
          left: { kind: 'op', op: '*', left: { kind: 'feature', featureKey: 'boom' }, right: { kind: 'const', value: 2 } },
          right: { kind: 'const', value: 0.5 },
        },
        unit: 'm',
        decimals: 1,
      },
      { key: 'rated_load_kg', label: 'Rated load', expr: { kind: 'lookup', lookupKey: 'rated_load' }, unit: 'kg', decimals: 0 },
    ],
    lookups: [
      {
        kind: 'value',
        key: 'boom_skus',
        label: 'Boom parts',
        keyedBy: 'boom',
        rows: [
          { match: '10', value: 'TH-BOOM-10' },
          { match: '14', value: 'TH-BOOM-14' },
        ],
      },
      {
        kind: 'value',
        key: 'attachment_skus',
        label: 'Attachment parts',
        keyedBy: 'attachment',
        rows: [
          { match: 'forks', value: 'TH-ATT-FORKS' },
          { match: 'bucket', value: 'TH-ATT-BUCKET' },
        ],
      },
      {
        kind: 'value',
        key: 'rated_load',
        label: 'Rated load by boom',
        keyedBy: 'boom',
        rows: [
          { match: '10', value: 3500 },
          { match: '14', value: 3000 },
        ],
      },
    ],
    bom: [
      { id: 'chassis', sku: 'TH-CHASSIS', uom: 'pc', quantity: 1, when: [], order: 1 },
      { id: 'boom', skuFromLookup: { lookupKey: 'boom_skus', keyedBy: 'boom' }, uom: 'pc', quantity: 1, when: [], order: 2 },
      {
        id: 'attachment',
        skuFromLookup: { lookupKey: 'attachment_skus', keyedBy: 'attachment' },
        uom: 'pc',
        quantity: 1,
        when: [],
        order: 3,
      },
      {
        id: 'cab',
        sku: 'TH-CAB-ENCL',
        uom: 'pc',
        quantity: 1,
        when: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }],
        order: 4,
      },
      { id: 'heater', sku: 'TH-HEATER', uom: 'pc', quantity: 1, when: [isTrue('heater')], order: 5 },
      { id: 'aux_valve', sku: 'TH-AUX-VALVE', uom: 'pc', quantity: 1, when: [isTrue('aux_hydraulics')], order: 6 },
      { id: 'aux_hose', sku: 'TH-HOSE-M', uom: 'm', quantity: { formulaKey: 'hose_m' }, when: [isTrue('aux_hydraulics')], order: 7 },
      { id: 'spare_hose', sku: 'TH-HOSE-M', uom: 'm', quantity: 5, when: [isTrue('aux_hydraulics')], order: 8 },
    ],
  }
}
