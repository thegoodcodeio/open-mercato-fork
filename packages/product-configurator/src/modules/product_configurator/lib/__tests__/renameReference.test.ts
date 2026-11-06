import {
  definitionSchema,
  type ConfigurationDefinition,
  type ConfigurationDefinitionInput,
} from '../../data/validators'
import { indexDefinition } from '../evaluator/context'
import { buildReferenceDefinition } from '../referenceModel'
import { renameReference, type RenameReferenceKind } from '../renameReference'
import {
  checkDuplicateKeys,
  checkLookupCoverage,
  checkPlaceholders,
  checkReferentialIntegrity,
  checkSurchargeBindings,
} from '../validation/definitionChecks'
import { checkFormulaCycles, checkNumericExpressionReferences } from '../validation/formulas'
import { PRICE_KIND_ID } from './fixtures'

function augment(input: ConfigurationDefinitionInput): void {
  input.features.push({
    key: 'stripe',
    label: 'Stripe',
    type: 'color',
    optionsFromLookup: 'paint_by_cab',
    default: 'yellow',
    order: 7,
    inSummary: false,
  })
  input.lookups.push({
    kind: 'permitted',
    key: 'paint_by_cab',
    keyedBy: 'cab',
    rows: [
      { match: 'open', values: ['yellow', 'green'], default: 'yellow' },
      { match: 'enclosed', values: ['yellow'], default: 'yellow' },
    ],
  })
  input.formulas.push({
    key: 'hose_total_m',
    expr: { kind: 'op', op: '+', left: { kind: 'formula', formulaKey: 'hose_m' }, right: { kind: 'const', value: 5 } },
  })
  input.rules.push(
    {
      id: 'E-PAINT-CAB',
      effect: 'error',
      when: [{ kind: 'not_in_lookup', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'cab' }],
      messageTemplate: 'Colour {feature.paint} is not offered with the {feature.cab} roof ({feature.paint}).',
      featureKeys: ['paint', 'cab'],
      order: 3,
    },
    {
      id: 'F-PAINT-DEFAULT',
      effect: 'force',
      when: [
        { kind: 'includes', featureKey: 'attachment', value: 'bucket' },
        { kind: 'not_includes', featureKey: 'cab', value: 'open' },
      ],
      action: { kind: 'lookup_default', featureKey: 'paint', lookupKey: 'paint_by_cab', keyedBy: 'cab' },
      messageTemplate: '',
      featureKeys: ['paint'],
      order: 4,
    },
    {
      id: 'F-STRIPE-MAP',
      effect: 'force',
      when: [],
      action: { kind: 'map', featureKey: 'stripe', from: { yellow: 'green' } },
      messageTemplate: '',
      featureKeys: ['stripe'],
      order: 5,
    },
    {
      id: 'S-HEATER',
      effect: 'surcharge',
      when: [{ kind: 'compare', featureKey: 'heater', op: 'eq', value: 'true' }],
      messageTemplate: 'Adds {line.heater.total} ({formula.hose_total_m} m).',
      featureKeys: ['heater'],
      order: 6,
    },
  )
  const heaterLine = input.bom.find((line) => line.id === 'heater')
  if (!heaterLine) throw new Error('reference model has no heater line')
  heaterLine.ruleId = 'S-HEATER'
}

function fullReference(): ConfigurationDefinition {
  const input = buildReferenceDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID })
  augment(input)
  return definitionSchema.parse(input)
}

function referenceIssues(definition: ConfigurationDefinition) {
  const index = indexDefinition(definition)
  return [
    ...checkDuplicateKeys(index),
    ...checkReferentialIntegrity(index),
    ...checkLookupCoverage(index),
    ...checkFormulaCycles(definition),
    ...checkNumericExpressionReferences(index),
    ...checkSurchargeBindings(index),
    ...checkPlaceholders(index),
  ]
}

function renameDeclaration(
  definition: ConfigurationDefinition,
  kind: RenameReferenceKind,
  from: string,
  to: string,
): ConfigurationDefinition {
  const renameKey = <T extends { key: string }>(row: T): T => (row.key === from ? { ...row, key: to } : row)
  const renameId = <T extends { id: string }>(row: T): T => (row.id === from ? { ...row, id: to } : row)
  switch (kind) {
    case 'feature':
      return { ...definition, features: definition.features.map(renameKey) }
    case 'formula':
      return { ...definition, formulas: definition.formulas.map(renameKey) }
    case 'lookup':
      return { ...definition, lookups: definition.lookups.map(renameKey) }
    case 'rule':
      return { ...definition, rules: definition.rules.map(renameId) }
    case 'bom':
      return { ...definition, bom: definition.bom.map(renameId) }
  }
}

function declarations(definition: ConfigurationDefinition): Array<[RenameReferenceKind, string]> {
  return [
    ...definition.features.map((feature): [RenameReferenceKind, string] => ['feature', feature.key]),
    ...definition.formulas.map((formula): [RenameReferenceKind, string] => ['formula', formula.key]),
    ...definition.lookups.map((lookup): [RenameReferenceKind, string] => ['lookup', lookup.key]),
    ...definition.rules.map((rule): [RenameReferenceKind, string] => ['rule', rule.id]),
    ...definition.bom.map((line): [RenameReferenceKind, string] => ['bom', line.id]),
  ]
}

function rule(definition: ConfigurationDefinition, id: string) {
  const found = definition.rules.find((entry) => entry.id === id)
  if (!found) throw new Error(`no rule ${id}`)
  return found
}

function bomLine(definition: ConfigurationDefinition, id: string) {
  const found = definition.bom.find((entry) => entry.id === id)
  if (!found) throw new Error(`no BOM line ${id}`)
  return found
}

function feature(definition: ConfigurationDefinition, key: string) {
  const found = definition.features.find((entry) => entry.key === key)
  if (!found) throw new Error(`no feature ${key}`)
  return found
}

function formula(definition: ConfigurationDefinition, key: string) {
  const found = definition.formulas.find((entry) => entry.key === key)
  if (!found) throw new Error(`no formula ${key}`)
  return found
}

function lookup(definition: ConfigurationDefinition, key: string) {
  const found = definition.lookups.find((entry) => entry.key === key)
  if (!found) throw new Error(`no lookup ${key}`)
  return found
}

function field(value: object | undefined, name: string): unknown {
  return Object.entries(value ?? {}).find(([key]) => key === name)?.[1]
}

type ReferenceSite = {
  site: string
  kind: RenameReferenceKind
  from: string
  read: (definition: ConfigurationDefinition) => unknown
}

const REFERENCE_SITES: ReferenceSite[] = [
  { site: 'feature.visibleWhen compare featureKey', kind: 'feature', from: 'cab', read: (d) => field(feature(d, 'heater').visibleWhen?.[0], 'featureKey') },
  { site: 'feature.optionsFromLookup', kind: 'lookup', from: 'paint_by_cab', read: (d) => feature(d, 'stripe').optionsFromLookup },
  { site: 'lookup.keyedBy', kind: 'feature', from: 'boom', read: (d) => lookup(d, 'rated_load').keyedBy },
  { site: 'rule.when compare featureKey', kind: 'feature', from: 'attachment', read: (d) => field(rule(d, 'W-BUCKET-LOAD').when[0], 'featureKey') },
  { site: 'rule.when calculated formulaKey', kind: 'formula', from: 'rated_load_kg', read: (d) => field(rule(d, 'W-BUCKET-LOAD').when[1], 'formulaKey') },
  { site: 'rule.when includes featureKey', kind: 'feature', from: 'attachment', read: (d) => field(rule(d, 'F-PAINT-DEFAULT').when[0], 'featureKey') },
  { site: 'rule.when not_includes featureKey', kind: 'feature', from: 'cab', read: (d) => field(rule(d, 'F-PAINT-DEFAULT').when[1], 'featureKey') },
  { site: 'rule.when not_in_lookup featureKey', kind: 'feature', from: 'paint', read: (d) => field(rule(d, 'E-PAINT-CAB').when[0], 'featureKey') },
  { site: 'rule.when not_in_lookup lookupKey', kind: 'lookup', from: 'paint_by_cab', read: (d) => field(rule(d, 'E-PAINT-CAB').when[0], 'lookupKey') },
  { site: 'rule.when not_in_lookup keyedBy', kind: 'feature', from: 'cab', read: (d) => field(rule(d, 'E-PAINT-CAB').when[0], 'keyedBy') },
  { site: 'rule.featureKeys', kind: 'feature', from: 'cab', read: (d) => rule(d, 'E-PAINT-CAB').featureKeys },
  { site: 'rule.action set featureKey', kind: 'feature', from: 'aux_hydraulics', read: (d) => rule(d, 'F-LONG-BOOM-HYDRAULICS').action?.featureKey },
  { site: 'rule.action map featureKey', kind: 'feature', from: 'stripe', read: (d) => rule(d, 'F-STRIPE-MAP').action?.featureKey },
  { site: 'rule.action lookup_default featureKey', kind: 'feature', from: 'paint', read: (d) => rule(d, 'F-PAINT-DEFAULT').action?.featureKey },
  { site: 'rule.action lookup_default lookupKey', kind: 'lookup', from: 'paint_by_cab', read: (d) => field(rule(d, 'F-PAINT-DEFAULT').action, 'lookupKey') },
  { site: 'rule.action lookup_default keyedBy', kind: 'feature', from: 'cab', read: (d) => field(rule(d, 'F-PAINT-DEFAULT').action, 'keyedBy') },
  { site: 'rule.messageTemplate {feature.<key>}', kind: 'feature', from: 'paint', read: (d) => rule(d, 'E-PAINT-CAB').messageTemplate },
  { site: 'rule.messageTemplate {formula.<key>}', kind: 'formula', from: 'hose_m', read: (d) => rule(d, 'F-LONG-BOOM-HYDRAULICS').messageTemplate },
  { site: 'rule.messageTemplate {lookup.<key>}', kind: 'lookup', from: 'rated_load', read: (d) => rule(d, 'W-BUCKET-LOAD').messageTemplate },
  { site: 'rule.messageTemplate {line.<id>.total}', kind: 'bom', from: 'heater', read: (d) => rule(d, 'S-HEATER').messageTemplate },
  { site: 'formula.expr feature', kind: 'feature', from: 'boom', read: (d) => formula(d, 'hose_m').expr },
  { site: 'formula.expr formula', kind: 'formula', from: 'hose_m', read: (d) => formula(d, 'hose_total_m').expr },
  { site: 'formula.expr lookup', kind: 'lookup', from: 'rated_load', read: (d) => formula(d, 'rated_load_kg').expr },
  { site: 'bom.when featureKey', kind: 'feature', from: 'aux_hydraulics', read: (d) => bomLine(d, 'aux_valve').when },
  { site: 'bom.quantity.formulaKey', kind: 'formula', from: 'hose_m', read: (d) => bomLine(d, 'aux_hose').quantity },
  { site: 'bom.skuFromLookup.lookupKey', kind: 'lookup', from: 'boom_skus', read: (d) => bomLine(d, 'boom').skuFromLookup?.lookupKey },
  { site: 'bom.skuFromLookup.keyedBy', kind: 'feature', from: 'boom', read: (d) => bomLine(d, 'boom').skuFromLookup?.keyedBy },
  { site: 'bom.ruleId', kind: 'rule', from: 'S-HEATER', read: (d) => bomLine(d, 'heater').ruleId },
]

describe('renameReference', () => {
  it('starts from a reference model with no unresolved references', () => {
    expect(referenceIssues(fullReference())).toEqual([])
  })

  it.each(REFERENCE_SITES)('rewrites $site', ({ kind, from, read }) => {
    const definition = fullReference()
    const to = kind === 'bom' || kind === 'rule' ? `${from}-renamed` : `${from}_renamed`
    const before = JSON.stringify(read(definition))
    const after = JSON.stringify(read(renameReference(definition, kind, from, to)))
    expect(before).toContain(from)
    expect(after).not.toEqual(before)
    expect(after).toEqual(before.split(from).join(to))
  })

  it('leaves every declaration and unrelated reference alone', () => {
    const definition = fullReference()
    const renamed = renameReference(definition, 'feature', 'cab', 'cabin')
    expect(renamed.features.map((entry) => entry.key)).toEqual(definition.features.map((entry) => entry.key))
    expect(renamed.bom.map((line) => line.id)).toEqual(definition.bom.map((line) => line.id))
    expect(bomLine(renamed, 'cab').when[0]).toEqual({ kind: 'compare', featureKey: 'cabin', op: 'eq', value: 'enclosed' })
    expect(rule(renamed, 'F-PAINT-DEFAULT').when[1]).toEqual({ kind: 'not_includes', featureKey: 'cabin', value: 'open' })
    expect(rule(renamed, 'E-PAINT-CAB').when[0]).toEqual({
      kind: 'not_in_lookup',
      featureKey: 'paint',
      lookupKey: 'paint_by_cab',
      keyedBy: 'cabin',
    })
  })

  it('only rewrites references of the given kind', () => {
    const definition = fullReference()
    const featureRenamed = renameReference(definition, 'feature', 'boom', 'reach')
    expect(bomLine(featureRenamed, 'boom').skuFromLookup).toEqual({ lookupKey: 'boom_skus', keyedBy: 'reach' })
    expect(featureRenamed.bom.map((line) => line.id)).toContain('boom')

    const lineRenamed = renameReference(definition, 'bom', 'heater', 'heater-line')
    expect(rule(lineRenamed, 'S-HEATER').messageTemplate).toBe('Adds {line.heater-line.total} ({formula.hose_total_m} m).')
    expect(feature(lineRenamed, 'heater').key).toBe('heater')
    expect(rule(lineRenamed, 'S-HEATER').when).toBe(rule(definition, 'S-HEATER').when)

    const lookupRenamed = renameReference(definition, 'lookup', 'hose_m', 'hose_lookup')
    expect(lookupRenamed).toBe(definition)
  })

  it('rewrites every occurrence of a placeholder and keeps text that only looks like one', () => {
    const definition = fullReference()
    const renamed = renameReference(
      { ...definition, rules: [{ ...rule(definition, 'E-PAINT-CAB'), messageTemplate: '{feature.paint}/{feature.paint}, feature.paint, {feature.paintwork}, {formula.paint}' }] },
      'feature',
      'paint',
      'colour',
    )
    expect(renamed.rules[0].messageTemplate).toBe('{feature.colour}/{feature.colour}, feature.paint, {feature.paintwork}, {formula.paint}')
  })

  it('returns the same definition when nothing changes', () => {
    const definition = fullReference()
    expect(renameReference(definition, 'feature', 'cab', 'cab')).toBe(definition)
    expect(renameReference(definition, 'feature', 'missing', 'other')).toBe(definition)
    expect(renameReference(definition, 'rule', 'W-BUCKET-LOAD', 'W-RENAMED')).toBe(definition)
  })

  it('keeps the identity of untouched branches', () => {
    const definition = fullReference()
    const renamed = renameReference(definition, 'formula', 'hose_m', 'hose_length')
    expect(renamed.features).toBe(definition.features)
    expect(renamed.lookups).toBe(definition.lookups)
    expect(rule(renamed, 'W-BUCKET-LOAD')).toBe(rule(definition, 'W-BUCKET-LOAD'))
    expect(bomLine(renamed, 'chassis')).toBe(bomLine(definition, 'chassis'))
    expect(formula(renamed, 'rated_load_kg')).toBe(formula(definition, 'rated_load_kg'))
    expect(formula(renamed, 'hose_total_m').expr).toEqual({
      kind: 'op',
      op: '+',
      left: { kind: 'formula', formulaKey: 'hose_length' },
      right: { kind: 'const', value: 5 },
    })
  })

  it('does not mutate its input', () => {
    const definition = fullReference()
    const snapshot = JSON.stringify(definition)
    renameReference(definition, 'feature', 'boom', 'reach')
    expect(JSON.stringify(definition)).toBe(snapshot)
  })

  it.each(declarations(fullReference()))('renames %s %s without leaving a stale reference', (kind, from) => {
    const definition = fullReference()
    const to = kind === 'bom' || kind === 'rule' ? `${from}-renamed` : `${from}_renamed`
    const declared = renameDeclaration(definition, kind, from, to)
    const renamed = renameReference(declared, kind, from, to)
    expect(referenceIssues(renamed)).toEqual([])
    if (referenceIssues(declared).length === 0) expect(renamed).toBe(declared)
    else expect(renamed).not.toBe(declared)
  })

  it('renames every key and id of the reference model in sequence without a stale reference', () => {
    const definition = fullReference()
    const renamed = declarations(definition).reduce((current, [kind, from]) => {
      const to = kind === 'bom' || kind === 'rule' ? `${from}-renamed` : `${from}_renamed`
      return renameReference(renameDeclaration(current, kind, from, to), kind, from, to)
    }, definition)
    expect(referenceIssues(renamed)).toEqual([])
    expect(declarations(renamed).every(([, key]) => /(_|-)renamed$/.test(key))).toBe(true)
  })
})
