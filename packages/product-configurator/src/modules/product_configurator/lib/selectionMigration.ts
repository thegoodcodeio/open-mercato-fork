import type { ConfigurationDefinition, Feature, SelectionValue } from '../data/validators'
import { indexDefinition } from './evaluator/context'
import { ConfiguratorEvaluationError, type SelectionIssueReason } from './evaluator/errors'
import { normaliseSelections } from './evaluator/structure'

export type MigrationReason = 'kept' | 'feature_removed' | 'option_removed' | 'out_of_range' | 'type_changed'

export type MigrationItem = {
  featureKey: string
  label: string
  oldValue: SelectionValue
  oldDisplay: SelectionValue
  /** Unit of a copied number in the old version; absent when the value has none. */
  oldUnit?: string
  reason: MigrationReason
}

export type MigrationVersionRef = { id: string; version: number }

export type SelectionMigration = {
  fromVersion: MigrationVersionRef
  toVersion: MigrationVersionRef
  kept: MigrationItem[]
  dropped: MigrationItem[]
  reset: MigrationItem[]
}

export type MigratedSelections = {
  selections: Record<string, SelectionValue>
  migration: SelectionMigration | null
}

const RESET_REASONS: Record<Exclude<SelectionIssueReason, 'unknown_feature'>, MigrationReason> = {
  not_an_option: 'option_removed',
  below_min: 'out_of_range',
  above_max: 'out_of_range',
  step: 'out_of_range',
  type: 'type_changed',
}

function isSelectionValue(value: unknown): value is SelectionValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

/** The copied intent: only plain selection values survive; anything else in stored JSON is ignored. */
export function readIntent(value: unknown): Record<string, SelectionValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, SelectionValue] => isSelectionValue(entry[1])))
}

function displayOf(feature: Feature | undefined, value: SelectionValue): Pick<MigrationItem, 'oldDisplay' | 'oldUnit'> {
  const oldDisplay = feature?.options?.find((option) => option.value === String(value))?.label ?? value
  return typeof value === 'number' && feature?.unit ? { oldDisplay, oldUnit: feature.unit } : { oldDisplay }
}

/** The per-feature problems the target version has with the copied intent, as the strict evaluate would report them. */
function selectionIssues(definition: ConfigurationDefinition, intent: Record<string, SelectionValue>): Map<string, SelectionIssueReason> {
  try {
    normaliseSelections(indexDefinition(definition), intent)
    return new Map()
  } catch (error) {
    if (!(error instanceof ConfiguratorEvaluationError) || error.code !== 'invalid_selection') throw error
    return new Map(error.issues.map((issue) => [issue.featureKey, issue.reason]))
  }
}

/**
 * Maps a snapshot's intent onto another model version. A choice whose feature is gone is dropped; a
 * value the new version refuses (removed option, out of range) or a feature whose type changed (even
 * when the old value would still pass) is reset, so the field takes its default or a force rule.
 * Nothing is replaced silently: the migration lists every copied choice, and it is null when the
 * version is the same or nothing was dropped or reset.
 */
export function migrateSelections(input: {
  intent: Record<string, SelectionValue>
  from: { ref: MigrationVersionRef; definition: ConfigurationDefinition }
  to: { ref: MigrationVersionRef; definition: ConfigurationDefinition }
}): MigratedSelections {
  const { intent, from, to } = input
  if (from.ref.id === to.ref.id) return { selections: { ...intent }, migration: null }

  const oldFeatures = new Map(from.definition.features.map((feature) => [feature.key, feature]))
  const newFeatures = new Map(to.definition.features.map((feature) => [feature.key, feature]))
  const issues = selectionIssues(to.definition, intent)
  const selections: Record<string, SelectionValue> = {}
  const kept: MigrationItem[] = []
  const dropped: MigrationItem[] = []
  const reset: MigrationItem[] = []

  for (const [featureKey, oldValue] of Object.entries(intent)) {
    const oldFeature = oldFeatures.get(featureKey)
    const newFeature = newFeatures.get(featureKey)
    const display = displayOf(oldFeature, oldValue)
    const issue = issues.get(featureKey)
    if (!newFeature) {
      dropped.push({ featureKey, label: oldFeature?.label ?? featureKey, oldValue, ...display, reason: 'feature_removed' })
      continue
    }
    if (oldFeature && oldFeature.type !== newFeature.type) {
      reset.push({ featureKey, label: newFeature.label, oldValue, ...display, reason: 'type_changed' })
      continue
    }
    if (issue && issue !== 'unknown_feature') {
      reset.push({ featureKey, label: newFeature.label, oldValue, ...display, reason: RESET_REASONS[issue] })
      continue
    }
    selections[featureKey] = oldValue
    kept.push({ featureKey, label: newFeature.label, oldValue, ...display, reason: 'kept' })
  }

  if (!dropped.length && !reset.length) return { selections, migration: null }
  return { selections, migration: { fromVersion: from.ref, toVersion: to.ref, kept, dropped, reset } }
}
