import type { Condition, Feature, Lookup, Rule, RuleAction, SelectionValue } from '../../../data/validators'
import { ruleSchema } from '../../../data/validators'
import { sortByOrder, toFiniteNumber } from '../../../lib/values'
import { conditionFeatureKeys } from '../conditionRowsModel'
import type { StudioDefinition } from './types'

export type RuleEffect = Rule['effect']
export type RuleActionKind = RuleAction['kind']

export const RULE_EFFECTS: readonly RuleEffect[] = ['error', 'warning', 'force', 'surcharge']
export const RULE_ACTION_KINDS: readonly RuleActionKind[] = ['set', 'map', 'lookup_default']

export type MapRow = { from: string; to: string }

/**
 * Editable force action. Every kind keeps its own fields, so switching the kind back and forth loses nothing.
 * `keyedBy` is not edited: like a BOM line's `skuFromLookup`, it is taken from the picked lookup on save.
 */
export type RuleActionForm = {
  kind: RuleActionKind
  featureKey: string
  setValue: SelectionValue
  mapRows: MapRow[]
  lookupKey: string
}

export type RuleFormValues = {
  label: string
  id: string
  effect: RuleEffect
  when: Condition[]
  /** Only written for `force` rules; kept while the effect changes. */
  action: RuleActionForm
  messageTemplate: string
  featureKeys: string[]
  /** False while "Fields highlighted for the rep" still follows the conditions. */
  featureKeysEdited: boolean
  order: string
}

/** Field id (`id`, `action.mapRows.1.to`, ...) -> i18n key of the message. */
export type RuleFormErrors = Record<string, string>

export type RuleFormResult = { ok: true; rule: Rule } | { ok: false; errors: RuleFormErrors }

const ERROR_PREFIX = 'product_configurator.studio.rules.errors.'

export const RULE_ERROR_KEYS = {
  required: `${ERROR_PREFIX}required`,
  integer: `${ERROR_PREFIX}integer`,
  invalidId: `${ERROR_PREFIX}invalidId`,
  duplicateId: `${ERROR_PREFIX}duplicateId`,
  mapRowsRequired: `${ERROR_PREFIX}mapRowsRequired`,
  duplicateMapRow: `${ERROR_PREFIX}duplicateMapRow`,
  lookupMissing: `${ERROR_PREFIX}lookupMissing`,
  invalid: `${ERROR_PREFIX}invalid`,
} as const

/** English fallbacks shown until the locale files carry the keys. */
export const RULE_ERROR_FALLBACKS: Record<string, string> = {
  [RULE_ERROR_KEYS.required]: 'This field is required.',
  [RULE_ERROR_KEYS.integer]: 'Enter a whole number.',
  [RULE_ERROR_KEYS.invalidId]: 'Use letters, digits, - and _ only (up to 100 characters).',
  [RULE_ERROR_KEYS.duplicateId]: 'Another rule already uses this id.',
  [RULE_ERROR_KEYS.mapRowsRequired]: 'Add at least one row.',
  [RULE_ERROR_KEYS.duplicateMapRow]: 'This value is already mapped.',
  [RULE_ERROR_KEYS.lookupMissing]: 'Pick a permitted lookup from this model.',
  [RULE_ERROR_KEYS.invalid]: 'This value is not valid.',
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const ID_MAX_LENGTH = 100

export function nextRuleOrder(rules: readonly Rule[]): number {
  return rules.reduce((highest, rule) => Math.max(highest, rule.order), 0) + 10
}

/** Features whose values are a fixed list, so a map can only produce allowed values. */
export function mappableFeatures(definition: StudioDefinition): Feature[] {
  return sortByOrder(definition.features).filter((feature) => feature.type === 'choice' || feature.type === 'color')
}

/** The permitted lookup a "lookup_default" action may read; its `keyedBy` is what the action stores. */
export function permittedLookup(definition: StudioDefinition, lookupKey: string): Lookup | undefined {
  return definition.lookups.find((lookup) => lookup.kind === 'permitted' && lookup.key === lookupKey)
}

/** The value a "set" action starts with for a feature: its first option, `true` for yes/no, its default otherwise. */
export function initialSetValue(feature: Feature | undefined): SelectionValue {
  if (!feature) return ''
  if (feature.type === 'boolean') return true
  if (feature.type === 'number') return typeof feature.default === 'number' ? feature.default : 0
  const first = feature.options ? sortByOrder(feature.options)[0]?.value : undefined
  return first ?? (typeof feature.default === 'string' ? feature.default : '')
}

function defaultActionForm(definition: StudioDefinition): RuleActionForm {
  const feature = sortByOrder(definition.features)[0]
  const lookup = definition.lookups.find((entry) => entry.kind === 'permitted')
  return {
    kind: 'set',
    featureKey: feature?.key ?? '',
    setValue: initialSetValue(feature),
    mapRows: [],
    lookupKey: lookup?.key ?? '',
  }
}

function actionToForm(action: RuleAction | undefined, definition: StudioDefinition): RuleActionForm {
  const fallback = defaultActionForm(definition)
  if (!action) return fallback
  switch (action.kind) {
    case 'set':
      return { ...fallback, kind: 'set', featureKey: action.featureKey, setValue: action.value }
    case 'map':
      return {
        ...fallback,
        kind: 'map',
        featureKey: action.featureKey,
        mapRows: Object.entries(action.from).map(([from, to]) => ({ from, to })),
      }
    case 'lookup_default':
      return { ...fallback, kind: 'lookup_default', featureKey: action.featureKey, lookupKey: action.lookupKey }
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

export function ruleToForm(rule: Rule | undefined, nextOrder: number, definition: StudioDefinition): RuleFormValues {
  if (!rule) {
    return {
      label: '',
      id: '',
      effect: 'error',
      when: [],
      action: defaultActionForm(definition),
      messageTemplate: '',
      featureKeys: [],
      featureKeysEdited: false,
      order: String(nextOrder),
    }
  }
  return {
    label: rule.label ?? '',
    id: rule.id,
    effect: rule.effect,
    when: rule.when,
    action: actionToForm(rule.action, definition),
    messageTemplate: rule.messageTemplate,
    featureKeys: rule.featureKeys,
    featureKeysEdited: !sameKeys(rule.featureKeys, conditionFeatureKeys(rule.when)),
    order: String(rule.order),
  }
}

/** New conditions; the highlighted fields follow them until the admin edits that list. */
export function withConditions(values: RuleFormValues, when: Condition[]): RuleFormValues {
  return values.featureKeysEdited ? { ...values, when } : { ...values, when, featureKeys: conditionFeatureKeys(when) }
}

/** Points the action at another feature, resetting the values that belonged to the previous one. */
export function withActionFeature(action: RuleActionForm, featureKey: string, definition: StudioDefinition): RuleActionForm {
  const feature = definition.features.find((entry) => entry.key === featureKey)
  return { ...action, featureKey, setValue: initialSetValue(feature), mapRows: [] }
}

export function withActionKind(action: RuleActionForm, kind: RuleActionKind, definition: StudioDefinition): RuleActionForm {
  if (kind !== 'map') return { ...action, kind }
  const mappable = mappableFeatures(definition)
  if (mappable.some((feature) => feature.key === action.featureKey)) return { ...action, kind }
  return { ...withActionFeature(action, mappable[0]?.key ?? '', definition), kind }
}

/** A new map row: the first value not mapped yet, swapped for the next allowed value. */
export function nextMapRow(rows: readonly MapRow[], values: readonly string[]): MapRow {
  const from = values.find((value) => !rows.some((row) => row.from === value)) ?? ''
  const to = values.find((value) => value !== from) ?? ''
  return { from, to }
}

function buildAction(action: RuleActionForm, definition: StudioDefinition, errors: RuleFormErrors): RuleAction | undefined {
  if (!action.featureKey) errors['action.featureKey'] = RULE_ERROR_KEYS.required
  switch (action.kind) {
    case 'set':
      if (action.setValue === '') errors['action.setValue'] = RULE_ERROR_KEYS.required
      return { kind: 'set', featureKey: action.featureKey, value: action.setValue }
    case 'map': {
      if (action.mapRows.length === 0) errors['action.mapRows'] = RULE_ERROR_KEYS.mapRowsRequired
      const seen = new Set<string>()
      action.mapRows.forEach((row, index) => {
        if (!row.from) errors[`action.mapRows.${index}.from`] = RULE_ERROR_KEYS.required
        else if (seen.has(row.from)) errors[`action.mapRows.${index}.from`] = RULE_ERROR_KEYS.duplicateMapRow
        if (!row.to) errors[`action.mapRows.${index}.to`] = RULE_ERROR_KEYS.required
        seen.add(row.from)
      })
      return { kind: 'map', featureKey: action.featureKey, from: Object.fromEntries(action.mapRows.map((row) => [row.from, row.to])) }
    }
    case 'lookup_default': {
      const lookup = permittedLookup(definition, action.lookupKey)
      if (!action.lookupKey) errors['action.lookupKey'] = RULE_ERROR_KEYS.required
      else if (!lookup) errors['action.lookupKey'] = RULE_ERROR_KEYS.lookupMissing
      return { kind: 'lookup_default', featureKey: action.featureKey, lookupKey: action.lookupKey, keyedBy: lookup?.keyedBy ?? '' }
    }
  }
}

/** Builds a schema-valid rule from the row editor, or the field errors that stop it. */
export function formToRule(values: RuleFormValues, otherIds: readonly string[], definition: StudioDefinition): RuleFormResult {
  const errors: RuleFormErrors = {}
  const id = values.id.trim()
  const label = values.label.trim()
  if (!id) errors.id = RULE_ERROR_KEYS.required
  else if (!ID_PATTERN.test(id) || id.length > ID_MAX_LENGTH) errors.id = RULE_ERROR_KEYS.invalidId
  else if (otherIds.includes(id)) errors.id = RULE_ERROR_KEYS.duplicateId
  const order = toFiniteNumber(values.order)
  if (order === null || !Number.isInteger(order)) errors.order = RULE_ERROR_KEYS.integer
  const action = values.effect === 'force' ? buildAction(values.action, definition, errors) : undefined
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const parsed = ruleSchema.safeParse({
    id,
    ...(label ? { label } : {}),
    effect: values.effect,
    when: values.when,
    ...(action ? { action } : {}),
    messageTemplate: values.messageTemplate,
    featureKeys: values.featureKeys,
    order,
  })
  if (parsed.success) return { ok: true, rule: parsed.data }
  for (const issue of parsed.error.issues) {
    const field = issue.path.map(String).join('.') || 'id'
    if (!errors[field]) errors[field] = RULE_ERROR_KEYS.invalid
  }
  return { ok: false, errors }
}

/** Inserts `token` in place of the selected text and returns the new text with the caret after the token. */
export function insertToken(text: string, token: string, selectionStart: number | null, selectionEnd: number | null): { text: string; caret: number } {
  const start = selectionStart ?? text.length
  const end = selectionEnd ?? start
  return { text: `${text.slice(0, start)}${token}${text.slice(end)}`, caret: start + token.length }
}

/** BOM lines whose total a rule's message may show: only lines bound to this surcharge rule. */
export function surchargeLineIds(definition: StudioDefinition, effect: RuleEffect, ruleId: string): string[] {
  if (effect !== 'surcharge' || !ruleId) return []
  return sortByOrder(definition.bom)
    .filter((line) => line.ruleId === ruleId)
    .map((line) => line.id)
}
