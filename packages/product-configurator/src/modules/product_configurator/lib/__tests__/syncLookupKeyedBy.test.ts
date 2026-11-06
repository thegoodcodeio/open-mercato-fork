import { definitionSchema, type ConfigurationDefinition, type Condition } from '../../data/validators'
import { indexDefinition } from '../evaluator/context'
import { buildReferenceDefinition } from '../referenceModel'
import { syncLookupKeyedBy } from '../syncLookupKeyedBy'
import { checkReferentialIntegrity } from '../validation/definitionChecks'
import { PRICE_KIND_ID } from './fixtures'

const paintNotForCab: Condition = { kind: 'not_in_lookup', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'cab' }
const paintNotForBoom: Condition = { kind: 'not_in_lookup', featureKey: 'paint', lookupKey: 'paint_by_boom', keyedBy: 'boom' }

function definition(): ConfigurationDefinition {
  const input = buildReferenceDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID })
  input.features.push({
    key: 'stripe',
    label: 'Stripe',
    type: 'boolean',
    default: false,
    order: 7,
    inSummary: false,
    visibleWhen: [{ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' }, paintNotForCab, paintNotForBoom],
  })
  input.lookups.push(
    {
      kind: 'permitted',
      key: 'paint_by_cab',
      keyedBy: 'cab',
      rows: [
        { match: 'open', values: ['yellow', 'green'], default: 'yellow' },
        { match: 'enclosed', values: ['yellow'], default: 'yellow' },
      ],
    },
    {
      kind: 'permitted',
      key: 'paint_by_boom',
      keyedBy: 'boom',
      rows: [
        { match: '10', values: ['yellow', 'green'], default: 'yellow' },
        { match: '14', values: ['yellow'], default: 'yellow' },
      ],
    },
  )
  input.rules.push(
    {
      id: 'E-PAINT-CAB',
      effect: 'error',
      when: [paintNotForCab, paintNotForBoom],
      messageTemplate: 'Colour {feature.paint} is not offered with this cab.',
      featureKeys: ['paint', 'cab'],
      order: 3,
    },
    {
      id: 'F-PAINT-DEFAULT',
      effect: 'force',
      when: [{ kind: 'compare', featureKey: 'attachment', op: 'eq', value: 'bucket' }],
      action: { kind: 'lookup_default', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'cab' },
      messageTemplate: '',
      featureKeys: ['paint'],
      order: 4,
    },
    {
      id: 'F-PAINT-BOOM-DEFAULT',
      effect: 'force',
      when: [paintNotForCab],
      action: { kind: 'lookup_default', featureKey: 'paint', lookupKey: 'paint_by_boom', keyedBy: 'boom' },
      messageTemplate: '',
      featureKeys: ['paint'],
      order: 5,
    },
  )
  const cabLine = input.bom.find((line) => line.id === 'cab')
  if (!cabLine) throw new Error('reference model has no cab line')
  cabLine.when.push(paintNotForCab)
  return definitionSchema.parse(input)
}

function redeclare(current: ConfigurationDefinition, lookupKey: string, keyedBy: string): ConfigurationDefinition {
  return {
    ...current,
    lookups: current.lookups.map((lookup) => (lookup.key === lookupKey ? { ...lookup, keyedBy } : lookup)),
  }
}

function find<T>(list: T[], match: (item: T) => boolean): T {
  const found = list.find(match)
  if (!found) throw new Error('fixture row missing')
  return found
}

const rule = (current: ConfigurationDefinition, id: string) => find(current.rules, (entry) => entry.id === id)
const bomLine = (current: ConfigurationDefinition, id: string) => find(current.bom, (entry) => entry.id === id)
const feature = (current: ConfigurationDefinition, key: string) => find(current.features, (entry) => entry.key === key)

type Site = { site: string; read: (current: ConfigurationDefinition) => unknown; expected: unknown }

const PAINT_BY_CAB_SITES: Site[] = [
  {
    site: 'feature.visibleWhen not_in_lookup',
    read: (current) => feature(current, 'stripe').visibleWhen?.[1],
    expected: { ...paintNotForCab, keyedBy: 'attachment' },
  },
  {
    site: 'rule.when not_in_lookup',
    read: (current) => rule(current, 'E-PAINT-CAB').when[0],
    expected: { ...paintNotForCab, keyedBy: 'attachment' },
  },
  {
    site: 'rule.when not_in_lookup on a rule whose action uses another lookup',
    read: (current) => rule(current, 'F-PAINT-BOOM-DEFAULT').when[0],
    expected: { ...paintNotForCab, keyedBy: 'attachment' },
  },
  {
    site: 'rule.action lookup_default',
    read: (current) => rule(current, 'F-PAINT-DEFAULT').action,
    expected: { kind: 'lookup_default', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'attachment' },
  },
  {
    site: 'bom.when not_in_lookup',
    read: (current) => bomLine(current, 'cab').when[1],
    expected: { ...paintNotForCab, keyedBy: 'attachment' },
  },
]

describe('syncLookupKeyedBy', () => {
  it('starts from a definition with consistent lookup consumers', () => {
    expect(checkReferentialIntegrity(indexDefinition(definition()))).toEqual([])
  })

  it.each(PAINT_BY_CAB_SITES)('rewrites keyedBy on $site', ({ read, expected }) => {
    expect(read(syncLookupKeyedBy(definition(), 'paint_by_cab', 'attachment'))).toEqual(expected)
  })

  it('rewrites keyedBy on bom.skuFromLookup', () => {
    const synced = syncLookupKeyedBy(definition(), 'boom_skus', 'attachment')
    expect(bomLine(synced, 'boom').skuFromLookup).toEqual({ lookupKey: 'boom_skus', keyedBy: 'attachment' })
    expect(bomLine(synced, 'attachment').skuFromLookup).toEqual({ lookupKey: 'attachment_skus', keyedBy: 'attachment' })
  })

  it('leaves consumers of other lookups and the lookup declaration alone', () => {
    const original = definition()
    const synced = syncLookupKeyedBy(original, 'paint_by_cab', 'attachment')
    expect(feature(synced, 'stripe').visibleWhen?.[0]).toEqual({ kind: 'compare', featureKey: 'cab', op: 'eq', value: 'enclosed' })
    expect(feature(synced, 'stripe').visibleWhen?.[2]).toBe(feature(original, 'stripe').visibleWhen?.[2])
    expect(rule(synced, 'E-PAINT-CAB').when[1]).toEqual(paintNotForBoom)
    expect(rule(synced, 'F-PAINT-BOOM-DEFAULT').action).toBe(rule(original, 'F-PAINT-BOOM-DEFAULT').action)
    expect(bomLine(synced, 'boom').skuFromLookup).toBe(bomLine(original, 'boom').skuFromLookup)
    expect(synced.lookups).toBe(original.lookups)
  })

  it('makes a redeclared lookup consistent with its consumers again', () => {
    const redeclared = redeclare(definition(), 'paint_by_cab', 'attachment')
    expect(checkReferentialIntegrity(indexDefinition(redeclared))).not.toEqual([])
    expect(checkReferentialIntegrity(indexDefinition(syncLookupKeyedBy(redeclared, 'paint_by_cab', 'attachment')))).toEqual([])
  })

  it('returns the same definition when nothing changes', () => {
    const original = definition()
    expect(syncLookupKeyedBy(original, 'paint_by_cab', 'cab')).toBe(original)
    expect(syncLookupKeyedBy(original, 'missing', 'attachment')).toBe(original)
    expect(syncLookupKeyedBy(original, 'rated_load', 'attachment')).toBe(original)
  })

  it('keeps the identity of untouched branches', () => {
    const original = definition()
    const synced = syncLookupKeyedBy(original, 'boom_skus', 'attachment')
    expect(synced).not.toBe(original)
    expect(synced.features).toBe(original.features)
    expect(synced.rules).toBe(original.rules)
    expect(synced.formulas).toBe(original.formulas)
    expect(synced.lookups).toBe(original.lookups)
    expect(bomLine(synced, 'chassis')).toBe(bomLine(original, 'chassis'))
    expect(bomLine(synced, 'boom').when).toBe(bomLine(original, 'boom').when)

    const cabSynced = syncLookupKeyedBy(original, 'paint_by_cab', 'attachment')
    expect(feature(cabSynced, 'heater')).toBe(feature(original, 'heater'))
    expect(rule(cabSynced, 'W-BUCKET-LOAD')).toBe(rule(original, 'W-BUCKET-LOAD'))
    expect(rule(cabSynced, 'F-PAINT-DEFAULT').when).toBe(rule(original, 'F-PAINT-DEFAULT').when)
    expect(bomLine(cabSynced, 'boom')).toBe(bomLine(original, 'boom'))
  })

  it('does not add absent optional fields to the rows it rewrites', () => {
    const synced = syncLookupKeyedBy(definition(), 'paint_by_cab', 'attachment')
    expect(Object.keys(rule(synced, 'E-PAINT-CAB'))).not.toContain('action')
    expect(Object.keys(bomLine(synced, 'cab'))).not.toContain('skuFromLookup')
  })

  it('does not mutate its input', () => {
    const original = definition()
    const snapshot = JSON.stringify(original)
    syncLookupKeyedBy(original, 'paint_by_cab', 'attachment')
    syncLookupKeyedBy(original, 'boom_skus', 'attachment')
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})
