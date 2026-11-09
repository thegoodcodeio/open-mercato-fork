import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { Condition, Feature, SelectionValue } from '../../data/validators'
import { sortByOrder } from '../../lib/values'
import { featureName, formulaName, lookupName } from './names'
import type { StudioDefinition } from './tabs/types'

export type ConditionGroup = 'feature' | 'calculated' | 'text' | 'lookup'
export type CompareOp = Extract<Condition, { kind: 'compare' }>['op']
export type OrderingOp = Extract<Condition, { kind: 'calculated' }>['op']

export const CONDITION_GROUPS: readonly ConditionGroup[] = ['feature', 'calculated', 'text', 'lookup']
export const COMPARE_OPS: readonly CompareOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']
export const ORDERING_OPS: readonly OrderingOp[] = ['gt', 'gte', 'lt', 'lte']

export const OPERATOR_LABELS: Record<CompareOp | 'includes' | 'not_includes' | 'not_in_lookup', { key: string; fallback: string }> = {
  eq: { key: 'product_configurator.studio.conditions.ops.eq', fallback: 'is' },
  neq: { key: 'product_configurator.studio.conditions.ops.neq', fallback: 'is not' },
  gt: { key: 'product_configurator.studio.conditions.ops.gt', fallback: '>' },
  gte: { key: 'product_configurator.studio.conditions.ops.gte', fallback: '≥' },
  lt: { key: 'product_configurator.studio.conditions.ops.lt', fallback: '<' },
  lte: { key: 'product_configurator.studio.conditions.ops.lte', fallback: '≤' },
  includes: { key: 'product_configurator.studio.conditions.ops.includes', fallback: 'contains' },
  not_includes: { key: 'product_configurator.studio.conditions.ops.not_includes', fallback: 'does not contain' },
  not_in_lookup: { key: 'product_configurator.studio.conditions.ops.not_in_lookup', fallback: 'is not allowed by' },
}

const DESCRIBE_PREFIX = 'product_configurator.studio.conditions.describe.'

/** Whole-sentence templates per operator, so a translation can order the parts as its grammar needs. */
export const CONDITION_TEMPLATES: Record<keyof typeof OPERATOR_LABELS, { key: string; fallback: string }> = {
  eq: { key: `${DESCRIBE_PREFIX}eq`, fallback: '{feature} is {value}' },
  neq: { key: `${DESCRIBE_PREFIX}neq`, fallback: '{feature} is not {value}' },
  gt: { key: `${DESCRIBE_PREFIX}gt`, fallback: '{feature} > {value}' },
  gte: { key: `${DESCRIBE_PREFIX}gte`, fallback: '{feature} ≥ {value}' },
  lt: { key: `${DESCRIBE_PREFIX}lt`, fallback: '{feature} < {value}' },
  lte: { key: `${DESCRIBE_PREFIX}lte`, fallback: '{feature} ≤ {value}' },
  includes: { key: `${DESCRIBE_PREFIX}includes`, fallback: '{feature} contains {value}' },
  not_includes: { key: `${DESCRIBE_PREFIX}not_includes`, fallback: '{feature} does not contain {value}' },
  not_in_lookup: { key: `${DESCRIBE_PREFIX}not_in_lookup`, fallback: '{feature} is not allowed by {value}' },
}

export type ValueOption = { value: string; label: string }

export function conditionGroup(condition: Condition): ConditionGroup {
  switch (condition.kind) {
    case 'compare':
      return 'feature'
    case 'calculated':
      return 'calculated'
    case 'includes':
    case 'not_includes':
      return 'text'
    case 'not_in_lookup':
      return 'lookup'
  }
}

export function isOrderingOp(op: CompareOp): op is OrderingOp {
  return ORDERING_OPS.some((entry) => entry === op)
}

/** Allowed values a condition can compare a feature with: its options, the values of its permitted lookup, or yes/no. */
export function featureValueOptions(definition: StudioDefinition, feature: Feature | undefined, t: TranslateFn): ValueOption[] {
  if (!feature) return []
  if (feature.type === 'boolean') {
    return [
      { value: 'true', label: t('product_configurator.studio.conditions.yes', 'Yes') },
      { value: 'false', label: t('product_configurator.studio.conditions.no', 'No') },
    ]
  }
  if (feature.options) return sortByOrder(feature.options).map((option) => ({ value: option.value, label: option.label }))
  if (!feature.optionsFromLookup) return []
  const lookup = definition.lookups.find((entry) => entry.key === feature.optionsFromLookup)
  if (!lookup || lookup.kind !== 'permitted') return []
  const values = Array.from(new Set(lookup.rows.flatMap((row) => row.values)))
  return values.map((value) => ({ value, label: value }))
}

function initialCompareValue(definition: StudioDefinition, feature: Feature | undefined): SelectionValue {
  if (!feature) return ''
  if (feature.type === 'number') return typeof feature.default === 'number' ? feature.default : 0
  if (feature.type === 'boolean') return true
  const first = feature.options ? sortByOrder(feature.options)[0]?.value : undefined
  if (first !== undefined) return first
  return typeof feature.default === 'string' ? feature.default : ''
}

/** A new, schema-valid condition of the group, or `null` when the draft has nothing it could read. */
export function defaultCondition(group: ConditionGroup, definition: StudioDefinition, features: readonly Feature[]): Condition | null {
  const feature = features[0]
  switch (group) {
    case 'feature':
      return feature ? { kind: 'compare', featureKey: feature.key, op: 'eq', value: initialCompareValue(definition, feature) } : null
    case 'text':
      return feature ? { kind: 'includes', featureKey: feature.key, value: '' } : null
    case 'calculated': {
      const formula = definition.formulas[0]
      return formula ? { kind: 'calculated', formulaKey: formula.key, op: 'gt', value: 0 } : null
    }
    case 'lookup': {
      const lookup = definition.lookups[0]
      return feature && lookup ? { kind: 'not_in_lookup', featureKey: feature.key, lookupKey: lookup.key, keyedBy: lookup.keyedBy } : null
    }
  }
}

/** Points a feature-reading condition at another feature, resetting a compare value that would not fit. */
export function withFeatureKey(condition: Condition, featureKey: string, definition: StudioDefinition): Condition {
  if (condition.kind === 'calculated') return condition
  if (condition.kind !== 'compare') return { ...condition, featureKey }
  const feature = definition.features.find((entry) => entry.key === featureKey)
  const value = isOrderingOp(condition.op) ? (typeof condition.value === 'number' ? condition.value : 0) : initialCompareValue(definition, feature)
  return { ...condition, featureKey, value }
}

export function withCompareOp(condition: Extract<Condition, { kind: 'compare' }>, op: CompareOp, definition: StudioDefinition): Condition {
  if (isOrderingOp(op) === isOrderingOp(condition.op)) return { ...condition, op }
  const feature = definition.features.find((entry) => entry.key === condition.featureKey)
  return { ...condition, op, value: isOrderingOp(op) ? 0 : initialCompareValue(definition, feature) }
}

/** Feature keys read by the conditions, in first-use order (prefills "Fields highlighted for the rep"). */
export function conditionFeatureKeys(conditions: readonly Condition[]): string[] {
  const keys: string[] = []
  for (const condition of conditions) {
    if (condition.kind !== 'calculated' && !keys.includes(condition.featureKey)) keys.push(condition.featureKey)
  }
  return keys
}

function compareValueLabel(definition: StudioDefinition, condition: Extract<Condition, { kind: 'compare' }>, t: TranslateFn): string {
  const feature = definition.features.find((entry) => entry.key === condition.featureKey)
  const match = featureValueOptions(definition, feature, t).find((option) => option.value === String(condition.value))
  return match ? match.label : String(condition.value)
}

/** One-line reading of a condition, e.g. "Paint (paint) is Custom colour". */
export function describeCondition(condition: Condition, definition: StudioDefinition, t: TranslateFn): string {
  const sentence = (op: keyof typeof CONDITION_TEMPLATES, feature: string, value: string | number) =>
    t(CONDITION_TEMPLATES[op].key, CONDITION_TEMPLATES[op].fallback, { feature, value })
  switch (condition.kind) {
    case 'compare':
      return sentence(condition.op, featureName(definition, condition.featureKey), compareValueLabel(definition, condition, t))
    case 'includes':
    case 'not_includes':
      return sentence(condition.kind, featureName(definition, condition.featureKey), condition.value)
    case 'not_in_lookup':
      return sentence('not_in_lookup', featureName(definition, condition.featureKey), lookupName(definition, condition.lookupKey))
    case 'calculated':
      return sentence(condition.op, formulaName(definition, condition.formulaKey), condition.value)
  }
}

export function describeConditions(conditions: readonly Condition[] | undefined, definition: StudioDefinition, t: TranslateFn): string {
  if (!conditions || conditions.length === 0) return t('product_configurator.studio.conditions.always', 'always')
  const and = t('product_configurator.studio.conditions.and', 'and')
  return conditions.map((condition) => describeCondition(condition, definition, t)).join(` ${and} `)
}
