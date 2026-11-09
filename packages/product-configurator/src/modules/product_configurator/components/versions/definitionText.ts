import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { BomLineDefinition, Condition, Feature, RuleAction, SelectionValue } from '../../data/validators'
import { sortByOrder } from '../../lib/values'

const COMPARE_SYMBOLS: Record<Extract<Condition, { kind: 'compare' }>['op'], string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

export function formatValue(value: SelectionValue): string {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

export function formatCondition(condition: Condition, t: TranslateFn): string {
  switch (condition.kind) {
    case 'compare':
      return `feature.${condition.featureKey} ${COMPARE_SYMBOLS[condition.op]} ${formatValue(condition.value)}`
    case 'calculated':
      return `formula.${condition.formulaKey} ${COMPARE_SYMBOLS[condition.op]} ${condition.value}`
    case 'includes':
      return t('product_configurator.versions.conditions.includes', '{feature} includes {value}', {
        feature: `feature.${condition.featureKey}`,
        value: formatValue(condition.value),
      })
    case 'not_includes':
      return t('product_configurator.versions.conditions.notIncludes', '{feature} does not include {value}', {
        feature: `feature.${condition.featureKey}`,
        value: formatValue(condition.value),
      })
    case 'not_in_lookup':
      return t('product_configurator.versions.conditions.notInLookup', '{feature} is not in lookup {lookup} (by {keyedBy})', {
        feature: `feature.${condition.featureKey}`,
        lookup: condition.lookupKey,
        keyedBy: condition.keyedBy,
      })
  }
}

export function formatConditions(conditions: readonly Condition[] | undefined, t: TranslateFn): string {
  if (!conditions || conditions.length === 0) return t('product_configurator.versions.conditions.always', 'Always')
  return conditions.map((condition) => formatCondition(condition, t)).join(` ${t('product_configurator.versions.conditions.and', 'and')} `)
}

export function formatAction(action: RuleAction | undefined, t: TranslateFn): string {
  if (!action) return ''
  switch (action.kind) {
    case 'set':
      return `feature.${action.featureKey} := ${formatValue(action.value)}`
    case 'map':
      return t('product_configurator.versions.actions.map', 'Map feature.{feature}: {pairs}', {
        feature: action.featureKey,
        pairs: Object.entries(action.from)
          .map(([from, to]) => `${formatValue(from)} -> ${formatValue(to)}`)
          .join(', '),
      })
    case 'lookup_default':
      return t('product_configurator.versions.actions.lookupDefault', 'Default of lookup {lookup} by {keyedBy} into feature.{feature}', {
        lookup: action.lookupKey,
        keyedBy: action.keyedBy,
        feature: action.featureKey,
      })
  }
}

export function formatFeatureValues(feature: Feature, t: TranslateFn): string[] {
  const parts: string[] = []
  if (feature.options?.length) {
    parts.push(
      sortByOrder(feature.options)
        .map((option) => option.label)
        .join(', '),
    )
  }
  if (feature.optionsFromLookup) {
    parts.push(t('product_configurator.versions.features.fromLookup', 'From lookup {lookup}', { lookup: feature.optionsFromLookup }))
  }
  if (feature.min !== undefined) parts.push(t('product_configurator.versions.features.min', 'Min {value}', { value: feature.min }))
  if (feature.max !== undefined) parts.push(t('product_configurator.versions.features.max', 'Max {value}', { value: feature.max }))
  if (feature.step !== undefined) parts.push(t('product_configurator.versions.features.step', 'Step {value}', { value: feature.step }))
  return parts
}

export function formatBomSku(line: BomLineDefinition, t: TranslateFn): string {
  if (line.sku) return line.sku
  if (line.skuFromLookup) {
    return t('product_configurator.versions.bom.skuFromLookup', 'From lookup {lookup} by {keyedBy}', {
      lookup: line.skuFromLookup.lookupKey,
      keyedBy: line.skuFromLookup.keyedBy,
    })
  }
  return ''
}

export function formatBomQuantity(line: BomLineDefinition): string {
  return typeof line.quantity === 'number' ? String(line.quantity) : `formula.${line.quantity.formulaKey}`
}
