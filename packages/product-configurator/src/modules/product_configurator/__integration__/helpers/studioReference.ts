export type StudioReferenceSkus = { chassis: string; boom10: string; boom14: string; heater: string; hose: string }

export function studioReferenceSkus(suffix: string): StudioReferenceSkus {
  return {
    chassis: `QA-PCFG-CHASSIS-${suffix}`,
    boom10: `QA-PCFG-BOOM-10-${suffix}`,
    boom14: `QA-PCFG-BOOM-14-${suffix}`,
    heater: `QA-PCFG-HEATER-${suffix}`,
    hose: `QA-PCFG-HOSE-${suffix}`,
  }
}

/**
 * The reference telehandler of `lib/referenceModel.ts`, cut down to what TC-PCFG-010 builds through
 * the studio forms in reasonable time: every feature type (with `visibleWhen` and `optionsFromLookup`),
 * formulas, a value and a permitted lookup, every rule effect and force action, and fixed and lookup
 * BOM lines with a formula quantity and a surcharge binding. Parts are in `pc` (the unit fixture products use).
 */
export function buildStudioReferenceDefinition(input: { priceKindId: string; currencyCode: string; skus: StudioReferenceSkus }) {
  const { skus } = input
  return {
    schemaVersion: 1,
    commercial: { currencyCode: input.currencyCode, priceKindId: input.priceKindId, allowPromotions: false },
    fixedSpecification: [],
    features: [
      {
        key: 'boom',
        label: 'Boom length',
        type: 'choice',
        options: [
          { value: '10', label: '10 m', order: 1 },
          { value: '14', label: '14 m', order: 2 },
        ],
        default: '10',
        order: 10,
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
        order: 20,
        inSummary: true,
      },
      {
        key: 'cab',
        label: 'Cab',
        type: 'choice',
        options: [
          { value: 'open', label: 'Open ROPS canopy', order: 1 },
          { value: 'enclosed', label: 'Enclosed cab', order: 2 },
        ],
        default: 'open',
        order: 30,
        inSummary: true,
      },
      {
        key: 'heater',
        label: 'Cab heater',
        type: 'boolean',
        default: false,
        order: 40,
        inSummary: true,
        visibleWhen: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }],
      },
      { key: 'aux_hydraulics', label: 'Auxiliary hydraulics', type: 'boolean', default: false, order: 50, inSummary: true },
      {
        key: 'paint',
        label: 'Paint',
        type: 'color',
        options: [
          { value: 'yellow', label: 'Signal yellow', order: 1, swatch: '#F2B705' },
          { value: 'green', label: 'Farm green', order: 2, swatch: '#2E6B30' },
        ],
        optionsFromLookup: 'paint_by_cab',
        default: 'yellow',
        order: 60,
        inSummary: false,
      },
      { key: 'outreach', label: 'Extra outreach', type: 'number', min: 0, max: 4, step: 0.5, unit: 'm', default: 0, order: 70, inSummary: true },
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
        order: 10,
      },
      {
        id: 'W-BUCKET-LOAD',
        label: 'Reduced rated load with a bucket',
        effect: 'warning',
        when: [
          { kind: 'compare', featureKey: 'attachment', op: 'eq', value: 'bucket' },
          { kind: 'calculated', formulaKey: 'rated_load_kg', op: 'lt', value: 3600 },
        ],
        messageTemplate: 'The rated load with the {feature.attachment} on this boom is {lookup.rated_load} kg.',
        featureKeys: ['attachment'],
        order: 20,
      },
      {
        id: 'E-BUCKET-OPEN-CAB',
        label: 'A bucket needs the enclosed cab',
        effect: 'error',
        when: [
          { kind: 'compare', featureKey: 'attachment', op: 'eq', value: 'bucket' },
          { kind: 'compare', featureKey: 'cab', op: 'eq', value: 'open' },
        ],
        messageTemplate: 'The bucket needs the enclosed cab.',
        featureKeys: ['attachment', 'cab'],
        order: 30,
      },
      {
        id: 'S-HEATER',
        label: 'Cab heater surcharge',
        effect: 'surcharge',
        when: [{ kind: 'compare', featureKey: 'heater', op: 'eq', value: true }],
        messageTemplate: 'The cab heater adds {line.heater.total}.',
        featureKeys: ['heater'],
        order: 40,
      },
      {
        id: 'F-ENCLOSED-PAINT',
        label: 'Enclosed cabs take the permitted paint',
        effect: 'force',
        when: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }],
        action: { kind: 'lookup_default', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'cab' },
        messageTemplate: 'Enclosed cabs come in {feature.paint}.',
        featureKeys: ['cab'],
        order: 50,
      },
      {
        id: 'F-BUCKET-BOOM',
        label: 'Buckets go on the short boom',
        effect: 'force',
        when: [{ kind: 'compare', featureKey: 'attachment', op: 'eq', value: 'bucket' }],
        action: { kind: 'map', featureKey: 'boom', from: { '14': '10' } },
        messageTemplate: 'A bucket fits the 10 m boom only.',
        featureKeys: ['attachment'],
        order: 60,
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
          { match: '10', value: skus.boom10 },
          { match: '14', value: skus.boom14 },
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
      {
        kind: 'permitted',
        key: 'paint_by_cab',
        label: 'Paint by cab',
        keyedBy: 'cab',
        rows: [
          { match: 'open', values: ['yellow', 'green'], default: 'yellow' },
          { match: 'enclosed', values: ['yellow'], default: 'yellow' },
        ],
      },
    ],
    bom: [
      { id: 'chassis', sku: skus.chassis, uom: 'pc', quantity: 1, when: [], order: 10 },
      { id: 'boom', skuFromLookup: { lookupKey: 'boom_skus', keyedBy: 'boom' }, uom: 'pc', quantity: 1, when: [], order: 20 },
      {
        id: 'heater',
        sku: skus.heater,
        uom: 'pc',
        quantity: 1,
        when: [{ kind: 'compare', featureKey: 'heater', op: 'eq', value: true }],
        ruleId: 'S-HEATER',
        order: 30,
      },
      {
        id: 'aux_hose',
        sku: skus.hose,
        uom: 'pc',
        quantity: { formulaKey: 'hose_m' },
        when: [{ kind: 'compare', featureKey: 'aux_hydraulics', op: 'eq', value: true }],
        order: 40,
      },
    ],
  }
}

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical }

/** Sorted object keys, `undefined` dropped: the shape `hashDefinition` uses, readable in a diff. */
export function canonicalize(value: unknown): Canonical {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: { [key: string]: Canonical } = {}
    for (const key of Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (record[key] !== undefined) result[key] = canonicalize(record[key])
    }
    return result
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  return null
}
