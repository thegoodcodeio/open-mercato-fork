import type { ConfigurationDefinition, Feature } from '../../data/validators'
import { buildEmptyDefinition } from '../modelDraft'
import { migrateSelections, readIntent } from '../selectionMigration'

const PRICE_KIND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FROM = { id: '11111111-1111-4111-8111-111111111111', version: 3 }
const TO = { id: '22222222-2222-4222-8222-222222222222', version: 4 }

function definition(features: Feature[]): ConfigurationDefinition {
  return { ...buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID }), features }
}

const color = (options: Array<[string, string]>): Feature => ({
  key: 'color',
  label: 'Color',
  type: 'color',
  options: options.map(([value, label], order) => ({ value, label, order, swatch: '#112233' })),
  default: options[0][0],
  order: 0,
  inSummary: true,
})

const width = (range: { min?: number; max?: number; step?: number }): Feature => ({
  key: 'width',
  label: 'Width',
  type: 'number',
  ...range,
  unit: 'mm',
  default: 1000,
  order: 1,
  inSummary: true,
})

const lighting: Feature = { key: 'lighting', label: 'Lighting', type: 'boolean', default: false, order: 2, inSummary: true }

describe('migrateSelections', () => {
  it('keeps the intent and reports nothing on the same version', () => {
    const def = definition([color([['navy', 'Navy']])])
    expect(migrateSelections({ intent: { color: 'navy' }, from: { ref: FROM, definition: def }, to: { ref: FROM, definition: def } })).toEqual({
      selections: { color: 'navy' },
      migration: null,
    })
  })

  it('reports nothing when every copied choice is still valid on the new version', () => {
    const from = definition([color([['navy', 'Navy'], ['red', 'Red']]), width({ min: 500, max: 3000 })])
    const to = definition([color([['red', 'Red']]), width({ min: 500, max: 4000 })])
    expect(migrateSelections({ intent: { color: 'red', width: 2500 }, from: { ref: FROM, definition: from }, to: { ref: TO, definition: to } })).toEqual({
      selections: { color: 'red', width: 2500 },
      migration: null,
    })
  })

  it('drops removed features and resets removed options, out-of-range numbers and changed types', () => {
    const from = definition([color([['navy', 'Navy'], ['red', 'Signal red']]), width({ min: 500, max: 3000, step: 10 }), lighting])
    const to = definition([color([['navy', 'Navy']]), width({ min: 500, max: 2000, step: 10 })])
    const result = migrateSelections({
      intent: { color: 'red', width: 2500, lighting: true },
      from: { ref: FROM, definition: from },
      to: { ref: TO, definition: to },
    })
    expect(result.selections).toEqual({})
    expect(result.migration).toEqual({
      fromVersion: FROM,
      toVersion: TO,
      kept: [],
      dropped: [{ featureKey: 'lighting', label: 'Lighting', oldValue: true, oldDisplay: true, reason: 'feature_removed' }],
      reset: [
        { featureKey: 'color', label: 'Color', oldValue: 'red', oldDisplay: 'Signal red', reason: 'option_removed' },
        { featureKey: 'width', label: 'Width', oldValue: 2500, oldDisplay: 2500, oldUnit: 'mm', reason: 'out_of_range' },
      ],
    })
  })

  it('resets a value off the new step and a value whose feature changed its type, and keeps the rest', () => {
    const from = definition([width({ step: 5 }), { ...lighting }])
    const to = definition([width({ step: 10 }), { ...lighting, type: 'number', default: 0 }])
    const result = migrateSelections({ intent: { width: 1005, lighting: true }, from: { ref: FROM, definition: from }, to: { ref: TO, definition: to } })
    expect(result.migration?.reset.map((item) => [item.featureKey, item.reason])).toEqual([
      ['width', 'out_of_range'],
      ['lighting', 'type_changed'],
    ])

    const kept = migrateSelections({
      intent: { width: 1010, lighting: true },
      from: { ref: FROM, definition: from },
      to: { ref: TO, definition: definition([width({ step: 10 })]) },
    })
    expect(kept.selections).toEqual({ width: 1010 })
    expect(kept.migration?.kept).toEqual([{ featureKey: 'width', label: 'Width', oldValue: 1010, oldDisplay: 1010, oldUnit: 'mm', reason: 'kept' }])
    expect(kept.migration?.dropped.map((item) => item.featureKey)).toEqual(['lighting'])
  })
})

describe('migrateSelections type changes', () => {
  it('resets a choice whose feature changed its type even when the new type accepts the old value', () => {
    const choice: Feature = { ...color([['navy', 'Navy']]), type: 'choice', options: [{ value: 'navy', label: 'Navy', order: 0 }] }
    const result = migrateSelections({
      intent: { color: 'navy' },
      from: { ref: FROM, definition: definition([choice]) },
      to: { ref: TO, definition: definition([color([['navy', 'Navy']])]) },
    })
    expect(result.selections).toEqual({})
    expect(result.migration?.reset).toEqual([{ featureKey: 'color', label: 'Color', oldValue: 'navy', oldDisplay: 'Navy', reason: 'type_changed' }])
    expect(result.migration?.kept).toEqual([])
  })
})

describe('readIntent', () => {
  it('keeps only plain selection values', () => {
    expect(readIntent({ a: 'x', b: 2, c: true, d: null, e: { nested: 1 }, f: Number.NaN })).toEqual({ a: 'x', b: 2, c: true })
    expect(readIntent(null)).toEqual({})
    expect(readIntent(['x'])).toEqual({})
  })
})
