import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { ConfigurationDefinition, SelectionValue } from '../../../data/validators'
import type { WorkspaceEvaluation } from '../evaluationSchema'
import { formatSelectionValue } from '../workspaceModel'
import type { MigrationItem, SelectionMigration } from './sessionApi'

/** The copied value as the rep knew it: the old option label, a formatted number with its old unit, or yes/no. */
export function oldValueText(item: MigrationItem, locale: string, t: TranslateFn): string {
  const value = item.oldDisplay
  if (typeof value === 'boolean') return value ? t('product_configurator.configurator.values.yes', 'Yes') : t('product_configurator.configurator.values.no', 'No')
  if (typeof value === 'number') {
    const text = new Intl.NumberFormat(locale).format(value)
    return item.oldUnit ? `${text} ${item.oldUnit}` : text
  }
  return value
}

/** Why a copied choice could not be kept, in plain words. */
export function migrationReasonText(item: MigrationItem, migration: SelectionMigration, locale: string, t: TranslateFn): string {
  const params = { value: oldValueText(item, locale, t), label: item.label, version: migration.toVersion.version }
  switch (item.reason) {
    case 'feature_removed':
      return t('product_configurator.configurator.migration.reason.featureRemoved', '{label} was removed in v{version}.', params)
    case 'option_removed':
      return t('product_configurator.configurator.migration.reason.optionRemoved', '{value} was removed in v{version}.', params)
    case 'out_of_range':
      return t('product_configurator.configurator.migration.reason.outOfRange', '{value} is outside the range allowed in v{version}.', params)
    case 'type_changed':
      return t('product_configurator.configurator.migration.reason.typeChanged', '{label} changed in v{version}, so {value} no longer fits.', params)
    case 'kept':
      return ''
  }
}

/** The value a reset field settled to in the current result, formatted for the rep; null before the first result. */
export function currentValueText(
  definition: ConfigurationDefinition,
  evaluation: WorkspaceEvaluation | null,
  featureKey: string,
  locale: string,
  t: TranslateFn,
): string | null {
  const value: SelectionValue | undefined = evaluation?.selections[featureKey]
  if (value === undefined) return null
  const text = formatSelectionValue(definition, featureKey, value, locale, t)
  const unit = definition.features.find((feature) => feature.key === featureKey)?.unit
  return typeof value === 'number' && unit ? `${text} ${unit}` : text
}

/**
 * Inline markers for the fields a copy reset ("Reset to Navy: Signal red was removed in v4."), keyed by feature.
 * Dropped features are not in the model any more, so they are listed above the workspace instead.
 */
export function resetFieldNotes(
  definition: ConfigurationDefinition,
  migration: SelectionMigration | null,
  evaluation: WorkspaceEvaluation | null,
  locale: string,
  t: TranslateFn,
): Record<string, string> {
  if (!migration) return {}
  return Object.fromEntries(
    migration.reset.map((item) => {
      const reason = migrationReasonText(item, migration, locale, t)
      const current = currentValueText(definition, evaluation, item.featureKey, locale, t)
      const text = current
        ? t('product_configurator.configurator.migration.resetTo', 'Reset to {value}: {reason}', { value: current, reason })
        : t('product_configurator.configurator.migration.reset', 'Reset: {reason}', { reason })
      return [item.featureKey, text]
    }),
  )
}
