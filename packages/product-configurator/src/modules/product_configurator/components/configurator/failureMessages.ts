import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { ConfigurationDefinition } from '../../data/validators'
import type { SelectionIssue, WorkspaceFailure } from './evaluationSchema'

function nameOf(items: readonly { key?: string; id?: string; label?: string }[], ref: unknown): string {
  const text = typeof ref === 'string' ? ref : ''
  const item = items.find((entry) => entry.key === text || entry.id === text)
  return item?.label ?? text
}

function namesOf(items: readonly { key?: string; id?: string; label?: string }[], refs: unknown): string {
  return (Array.isArray(refs) ? refs : []).map((ref) => nameOf(items, ref)).join(', ')
}

/** The text of a failure shown in the summary; `null` for session conflicts, which the session view explains with its own actions. */
export function failureText(definition: ConfigurationDefinition, failure: WorkspaceFailure, t: TranslateFn): string | null {
  switch (failure.kind) {
    case 'session_changed':
    case 'session_not_open':
      return null
    case 'selection':
      return t('product_configurator.configurator.failure.selection', 'Fix the marked fields to see the price.')
    case 'transient':
      return t('product_configurator.configurator.failure.transient', 'Could not reach the server. Your last change was not applied.')
    case 'price_missing': {
      const skus = failure.skus.join(', ')
      return failure.channelId
        ? t('product_configurator.configurator.failure.priceMissingChannel', 'No catalog price for {skus} in this sales channel. An admin needs to add the price before this configuration can be added.', { skus })
        : t('product_configurator.configurator.failure.priceMissing', 'No catalog price for {skus}. An admin needs to add the price before this configuration can be added.', { skus })
    }
    case 'model_fix': {
      const params = failure.params
      if (failure.code === 'expression_error') {
        return t('product_configurator.configurator.failure.expression', 'This model needs a fix by an admin: the formula {formula} cannot be computed.', {
          formula: nameOf(definition.formulas, params.formulaKey),
        })
      }
      if (failure.code === 'fixed_point_not_reached') {
        return t('product_configurator.configurator.failure.fixedPoint', 'This model needs a fix by an admin: the rules {rules} keep changing each other.', {
          rules: namesOf(definition.rules, params.ruleIds),
        })
      }
      return t('product_configurator.configurator.failure.forcedValue', 'This model needs a fix by an admin: the rule {rule} sets a value that {feature} does not allow.', {
        rule: nameOf(definition.rules, params.ruleId),
        feature: nameOf(definition.features, params.featureKey),
      })
    }
    case 'other':
      if (failure.status === 403) return t('product_configurator.configurator.failure.forbidden', 'You do not have access to this configuration.')
      return failure.message ?? t('product_configurator.configurator.failure.other', 'This configuration could not be evaluated.')
  }
}

export function selectionIssueText(issue: SelectionIssue, t: TranslateFn): string {
  switch (issue.reason) {
    case 'below_min':
      return t('product_configurator.configurator.selection.belowMin', 'The value is below the minimum.')
    case 'above_max':
      return t('product_configurator.configurator.selection.aboveMax', 'The value is above the maximum.')
    case 'step':
      return t('product_configurator.configurator.selection.step', 'The value is not on a step.')
    case 'not_an_option':
      return t('product_configurator.configurator.selection.notAnOption', 'This option no longer exists. Choose another one.')
    default:
      return t('product_configurator.configurator.selection.type', 'This value is not valid.')
  }
}
