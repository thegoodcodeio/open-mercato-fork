import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { ConfigurationDefinition, Feature, SelectionValue } from '../../data/validators'
import { renderMessage } from '../../lib/messages'
import { parseDecimal } from '../../lib/money'
import { selectionKey, sortByOrder, toFiniteNumber } from '../../lib/values'
import type { WorkspaceEvaluation, WorkspaceSelections } from './evaluationSchema'

export type FeatureGroup = { name: string | null; features: Feature[] }

/** Visible features in `order`, grouped by `group`; groups keep the order of their first feature. */
export function featureGroups(definition: ConfigurationDefinition, visibility: Record<string, boolean> | null): FeatureGroup[] {
  const groups: FeatureGroup[] = []
  for (const feature of sortByOrder(definition.features)) {
    if (visibility && visibility[feature.key] === false) continue
    const name = feature.group ?? null
    const group = groups.find((entry) => entry.name === name)
    if (group) group.features.push(feature)
    else groups.push({ name, features: [feature] })
  }
  return groups
}

export type FeatureOption = { value: string; label: string; swatch?: string }

/** Authored options, or the values of the permitted lookup the feature takes its options from. */
export function featureOptions(definition: ConfigurationDefinition, feature: Feature): FeatureOption[] {
  if (feature.options) return feature.options.map((option) => ({ value: option.value, label: option.label, swatch: option.swatch }))
  const lookup = definition.lookups.find((entry) => entry.key === feature.optionsFromLookup)
  if (lookup?.kind !== 'permitted') return []
  return [...new Set(lookup.rows.flatMap((row) => row.values))].map((value) => ({ value, label: value }))
}

export type NumberInputCheck =
  | { ok: true; value: number }
  | { ok: false; reason: 'type' | 'below_min' | 'above_max' | 'step' }

function isOnStep(value: number, base: number, step: number): boolean {
  const parts = [parseDecimal(value), parseDecimal(base), parseDecimal(step)]
  const scale = Math.max(...parts.map((part) => part.scale))
  const [scaledValue, scaledBase, scaledStep] = parts.map((part) => part.coefficient * 10n ** BigInt(scale - part.scale))
  return (scaledValue - scaledBase) % scaledStep === 0n
}

/** The same checks the evaluator runs on a number, so a field error shows before anything is sent. */
export function checkNumberInput(feature: Feature, text: string): NumberInputCheck {
  const value = toFiniteNumber(text.trim().replace(',', '.'))
  if (value === null) return { ok: false, reason: 'type' }
  if (feature.min !== undefined && value < feature.min) return { ok: false, reason: 'below_min' }
  if (feature.max !== undefined && value > feature.max) return { ok: false, reason: 'above_max' }
  if (feature.step !== undefined && !isOnStep(value, feature.min ?? 0, feature.step)) return { ok: false, reason: 'step' }
  return { ok: true, value }
}

/** Drops choices for features the definition no longer has (for example after the studio saved a new draft). */
export function pruneSelections(definition: ConfigurationDefinition, selections: WorkspaceSelections): WorkspaceSelections {
  const keys = new Set(definition.features.map((feature) => feature.key))
  return Object.fromEntries(Object.entries(selections).filter(([key]) => keys.has(key)))
}

export function formatSelectionValue(definition: ConfigurationDefinition, featureKey: string, value: SelectionValue, locale: string, t: TranslateFn): string {
  const feature = definition.features.find((entry) => entry.key === featureKey)
  if (typeof value === 'boolean') {
    return value ? t('product_configurator.configurator.values.yes', 'Yes') : t('product_configurator.configurator.values.no', 'No')
  }
  if (typeof value === 'number') return new Intl.NumberFormat(locale).format(value)
  return feature?.options?.find((option) => option.value === value)?.label ?? value
}

export type WorkspaceMessage = {
  id: string
  severity: 'error' | 'warning' | 'info'
  text: string
  featureKeys: string[]
}

function featureLabel(definition: ConfigurationDefinition, key: unknown): string {
  const text = typeof key === 'string' ? key : ''
  return definition.features.find((feature) => feature.key === text)?.label ?? text
}

function systemIssueText(definition: ConfigurationDefinition, code: string, params: Record<string, unknown>, t: TranslateFn): string {
  const feature = featureLabel(definition, params.featureKey)
  const value = selectionKey(typeof params.value === 'string' || typeof params.value === 'number' ? params.value : null)
  switch (code) {
    case 'option_not_available':
      return t('product_configurator.configurator.issues.option_not_available', '{feature}: {value} is not available with the current choices.', { feature, value })
    case 'no_permitted_values':
      return t('product_configurator.configurator.issues.no_permitted_values', '{feature}: no option fits the current choices.', { feature })
    case 'bom_sku_unmapped':
      return t('product_configurator.configurator.issues.bom_sku_unmapped', 'No part is set for {feature} = {value}. An admin must fix the model.', { feature, value })
    case 'bom_negative_quantity':
      return t('product_configurator.configurator.issues.bom_negative_quantity', 'A part quantity is below zero. An admin must fix the model.')
    default:
      return t('product_configurator.configurator.issues.unknown', 'This configuration cannot be added yet.')
  }
}

/** Blocking errors, warnings, surcharges and values set by rules, as plain text linked to the fields they concern. */
export function workspaceMessages(
  definition: ConfigurationDefinition,
  evaluation: WorkspaceEvaluation,
  locale: string,
  t: TranslateFn,
): WorkspaceMessage[] {
  const rules = new Map(definition.rules.map((rule) => [rule.id, rule]))
  const ruleText = (ruleId: string, params: WorkspaceEvaluation['warnings'][number]['params']) => {
    const rule = rules.get(ruleId)
    const text = rule ? renderMessage(rule.messageTemplate, { definition, params, locale, pricedBom: evaluation.bom }).trim() : ''
    return text || rule?.label || t('product_configurator.configurator.messages.ruleFallback', 'A rule of this model applies.')
  }
  const messages: WorkspaceMessage[] = []
  evaluation.errors.forEach((issue, index) => {
    if ('ruleId' in issue) {
      messages.push({ id: `error-${index}`, severity: 'error', text: ruleText(issue.ruleId, issue.params), featureKeys: rules.get(issue.ruleId)?.featureKeys ?? [] })
      return
    }
    const featureKey = typeof issue.params.featureKey === 'string' && issue.params.featureKey ? [issue.params.featureKey] : []
    messages.push({ id: `error-${index}`, severity: 'error', text: systemIssueText(definition, issue.code, issue.params, t), featureKeys: featureKey })
  })
  evaluation.warnings.forEach((issue, index) => {
    messages.push({ id: `warning-${index}`, severity: 'warning', text: ruleText(issue.ruleId, issue.params), featureKeys: rules.get(issue.ruleId)?.featureKeys ?? [] })
  })
  evaluation.surcharges.forEach((notice, index) => {
    messages.push({ id: `surcharge-${index}`, severity: 'info', text: ruleText(notice.ruleId, notice.params), featureKeys: rules.get(notice.ruleId)?.featureKeys ?? [] })
  })
  evaluation.forced.forEach((change, index) => {
    const reason = rules.get(change.ruleId)?.label ?? t('product_configurator.configurator.forced.byRule', 'a rule of this model')
    messages.push({
      id: `forced-${index}`,
      severity: 'info',
      text: t('product_configurator.configurator.forced.message', 'Set automatically ({reason}): {feature} is {value}.', {
        reason,
        feature: featureLabel(definition, change.featureKey),
        value: formatSelectionValue(definition, change.featureKey, change.to, locale, t),
      }),
      featureKeys: [change.featureKey],
    })
  })
  return messages
}

export function featureFieldId(featureKey: string): string {
  return `configurator-feature-${featureKey}`
}
