import { build } from '../../../lib/__tests__/fixtures'
import { renameReference } from '../../../lib/renameReference'
import type { ValidationIssue } from '../../../lib/validation/types'
import { conditionFeatureKeys, defaultCondition, describeConditions, withCompareOp } from '../conditionRowsModel'
import { groupIssuesByTab, resolveRefTarget } from '../studioRefs'
import { applyReferenceChanges } from '../tabs/rowEditorSession'
import type { StudioDefinition } from '../tabs/types'
import { friendlyIssueParams } from '../validationMessages'

const t = (key: string, fallback?: unknown, params?: Record<string, string | number>) => {
  const template = typeof fallback === 'string' ? fallback : key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match))
}

describe('studio refs', () => {
  const definition = build()

  it('resolves keyed refs and schema paths to a tab and row', () => {
    expect(resolveRefTarget({ kind: 'rule', key: 'r1' }, definition)).toEqual({ tab: 'rules', key: 'r1' })
    expect(resolveRefTarget({ kind: 'product', key: 'p' }, definition)).toEqual({ tab: 'overview', key: null })
    expect(resolveRefTarget({ kind: 'path', path: 'features.1.default' }, definition)).toEqual({ tab: 'features', key: 'length' })
    expect(resolveRefTarget({ kind: 'path', path: 'schemaVersion' }, definition)).toEqual({ tab: 'advanced', key: null })
  })

  it('groups an issue under every tab it points at', () => {
    const issue: ValidationIssue = {
      check: 'referential_integrity',
      code: 'unknown_lookup',
      params: { lookupKey: 'missing', ownerKey: 'motor' },
      refs: [{ kind: 'bom', key: 'motor' }, { kind: 'lookup', key: 'missing' }],
    }
    const grouped = groupIssuesByTab([issue], definition)
    expect(grouped.bom).toEqual([{ issue, key: 'motor' }])
    expect(grouped.lookups).toEqual([{ issue, key: 'missing' }])
  })

  it('names keys with their friendly label', () => {
    const issue: ValidationIssue = {
      check: 'fixed_point',
      code: 'fixed_point_not_reached',
      params: { ruleIds: [], featureKeys: ['motor', 'unknown_key'] },
      refs: [],
    }
    expect(friendlyIssueParams(issue, definition).featureKeys).toBe('Motor (motor), unknown_key')
  })
})

describe('condition rows model', () => {
  const definition = build()

  it('creates schema-valid defaults and reads feature keys', () => {
    const compare = defaultCondition('feature', definition, definition.features)
    expect(compare).toEqual({ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'standard' })
    const lookup = defaultCondition('lookup', definition, definition.features)
    expect(lookup).toMatchObject({ kind: 'not_in_lookup', keyedBy: definition.lookups[0].keyedBy })
    expect(conditionFeatureKeys([compare!, compare!, { kind: 'calculated', formulaKey: 'weight', op: 'gt', value: 1 }])).toEqual(['motor'])
  })

  it('switches between equality and ordering operators with a fitting value', () => {
    const compare = { kind: 'compare' as const, featureKey: 'length', op: 'eq' as const, value: 2 }
    expect(withCompareOp(compare, 'gte', definition)).toEqual({ ...compare, op: 'gte', value: 0 })
  })

  it('describes conditions with option labels', () => {
    expect(describeConditions([{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }], definition, t)).toBe(
      'Motor (motor) is Heavy duty 7 kW',
    )
    expect(describeConditions([], definition, t)).toBe('always')
  })
})

describe('reference changes replayed by an open row editor', () => {
  const renameMotor = (definition: StudioDefinition) => renameReference(definition, 'feature', 'motor', 'drive')
  const withCover = (definition: StudioDefinition, featureKey: string) => {
    const cover = definition.features.find((feature) => feature.key === 'cover')
    if (!cover) throw new Error('[internal] missing fixture feature cover')
    return { ...definition, features: [{ ...cover, visibleWhen: [{ kind: 'compare' as const, featureKey, op: 'eq' as const, value: 'heavy' }] }] }
  }
  const visibleWhenKey = (definition: StudioDefinition) => {
    const [condition] = definition.features[0]?.visibleWhen ?? []
    return condition?.kind === 'compare' ? condition.featureKey : null
  }

  it('moves a reference picked before the rename to the new key', () => {
    expect(visibleWhenKey(applyReferenceChanges(withCover(build(), 'motor'), [renameMotor]))).toBe('drive')
  })

  it('also moves a reference to a key reused after the rename, since the log cannot tell when it was picked', () => {
    const reused = build((input) => {
      const motor = input.features.find((feature) => feature.key === 'motor')
      if (motor) motor.key = 'drive'
      input.features.push({ key: 'motor', label: 'New motor', type: 'boolean', default: false, order: 9, inSummary: false })
    })
    expect(visibleWhenKey(applyReferenceChanges(withCover(reused, 'motor'), [renameMotor]))).toBe('drive')
  })
})
