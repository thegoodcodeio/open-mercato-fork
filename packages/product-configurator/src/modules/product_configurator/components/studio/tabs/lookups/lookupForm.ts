import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { lookupSchema, type Lookup } from '../../../../data/validators'
import { sortByOrder, toFiniteNumber } from '../../../../lib/values'
import { featureValueOptions, type ValueOption } from '../../conditionRowsModel'
import type { StudioDefinition } from '../types'

export type LookupKind = Lookup['kind']

/**
 * `original` keeps the stored value, so saving an untouched row does not turn "40" into 40. `storedMatch` keeps
 * the stored match, which is kept as it is even with spaces around it.
 */
export type ValueRowForm = { match: string; text: string; original?: string | number; storedMatch?: string }
/**
 * `saved` marks a row read from the stored lookup, so an empty one is not taken for a placeholder; only a row
 * stored with no values (`storedEmpty`) may be saved without values.
 */
export type PermittedRowForm = {
  match: string
  values: string[]
  default: string
  saved?: boolean
  storedEmpty?: boolean
  storedMatch?: string
}

export type LookupFormValues = {
  label: string
  key: string
  kind: LookupKind
  keyedBy: string
  valueRows: ValueRowForm[]
  permittedRows: PermittedRowForm[]
}

/** Field id (`key`, `rows.3.value`, ...) -> i18n key of the message. */
export type LookupFormErrors = Record<string, string>

export type LookupFormResult = { ok: true; lookup: Lookup } | { ok: false; errors: LookupFormErrors }

const ERROR_PREFIX = 'product_configurator.studio.lookups.errors.'

export const LOOKUP_ERROR_KEYS = {
  required: `${ERROR_PREFIX}required`,
  invalidKey: `${ERROR_PREFIX}invalidKey`,
  duplicateKey: `${ERROR_PREFIX}duplicateKey`,
  unknownFeature: `${ERROR_PREFIX}unknownFeature`,
  duplicateMatch: `${ERROR_PREFIX}duplicateMatch`,
  valuesRequired: `${ERROR_PREFIX}valuesRequired`,
  matchSpaces: `${ERROR_PREFIX}matchSpaces`,
  defaultNotAllowed: `${ERROR_PREFIX}defaultNotAllowed`,
  invalid: `${ERROR_PREFIX}invalid`,
} as const

const LOOKUP_ERROR_FALLBACKS: Record<string, string> = {
  [LOOKUP_ERROR_KEYS.required]: 'Required.',
  [LOOKUP_ERROR_KEYS.invalidKey]: 'Use letters, digits and underscores, starting with a letter or underscore.',
  [LOOKUP_ERROR_KEYS.duplicateKey]: 'Another lookup already uses this key.',
  [LOOKUP_ERROR_KEYS.unknownFeature]: 'This feature is not in the draft. Its key may have changed, so pick the feature again.',
  [LOOKUP_ERROR_KEYS.duplicateMatch]: 'Another row already has this value.',
  [LOOKUP_ERROR_KEYS.valuesRequired]: 'Allow at least one value.',
  [LOOKUP_ERROR_KEYS.matchSpaces]: 'Remove the spaces at the start or end. Selections are matched exactly.',
  [LOOKUP_ERROR_KEYS.defaultNotAllowed]: 'The default must be one of the allowed values.',
  [LOOKUP_ERROR_KEYS.invalid]: 'This value is not valid.',
}

export function lookupErrorText(errors: LookupFormErrors, field: string, t: TranslateFn): string | undefined {
  const messageKey = errors[field]
  return messageKey ? t(messageKey, LOOKUP_ERROR_FALLBACKS[messageKey] ?? messageKey) : undefined
}

/** Options of the key feature (`null` for a number feature or a missing one: its rows are typed freely). */
export function keyDomain(definition: StudioDefinition, keyedBy: string, t: TranslateFn): ValueOption[] | null {
  const feature = definition.features.find((entry) => entry.key === keyedBy)
  if (!feature || feature.type === 'number') return null
  return featureValueOptions(definition, feature, t)
}

/** Options of the key feature that have no row; empty when the rows are typed freely. */
export function missingMatches(domain: readonly ValueOption[] | null, matches: readonly string[]): ValueOption[] {
  if (!domain) return []
  const present = new Set(matches)
  return domain.filter((option) => !present.has(option.value))
}

/** BOM lines that read their SKU from the lookup: its values are catalog SKUs. */
export function skuLineIds(definition: StudioDefinition, lookupKey: string): string[] {
  return sortByOrder(definition.bom)
    .filter((line) => line.skuFromLookup?.lookupKey === lookupKey)
    .map((line) => line.id)
}

/** Features whose options a permitted lookup limits. */
export function limitedFeatures(definition: StudioDefinition, lookupKey: string) {
  return sortByOrder(definition.features).filter((feature) => feature.optionsFromLookup === lookupKey)
}

/** Values a permitted row can allow: the options of the limited features, then any value already used or added. */
export function permittedValueDomain(
  definition: StudioDefinition,
  lookupKey: string,
  rows: readonly PermittedRowForm[],
  extraValues: readonly string[],
): ValueOption[] {
  const options: ValueOption[] = []
  const seen = new Set<string>()
  const add = (value: string, label: string) => {
    if (seen.has(value)) return
    seen.add(value)
    options.push({ value, label })
  }
  for (const feature of limitedFeatures(definition, lookupKey)) {
    for (const option of sortByOrder(feature.options ?? [])) add(option.value, option.label)
  }
  for (const row of rows) for (const value of row.values) add(value, value)
  for (const value of extraValues) add(value, value)
  return options
}

function isUntouchedValueRow(row: ValueRowForm): boolean {
  return row.original !== undefined && String(row.original) === row.text
}

/** False for a row left blank (an option row then has no row); a stored blank value kept as it was still counts. */
export function valueRowHasValue(row: ValueRowForm): boolean {
  return row.text.trim() !== '' || isUntouchedValueRow(row)
}

function isValuePlaceholder(row: ValueRowForm): boolean {
  return row.original === undefined && row.text.trim() === ''
}

function isPermittedPlaceholder(row: PermittedRowForm): boolean {
  return !row.saved && row.values.length === 0
}

/**
 * Keeps the rows in their stored order and adds a blank row for each option of the key feature that has none.
 * Blank rows that were never saved and are not options are dropped, so placeholders of a previous key feature
 * do not linger.
 */
function alignRows<Row extends { match: string }>(
  rows: readonly Row[],
  domain: readonly ValueOption[] | null,
  isPlaceholder: (row: Row) => boolean,
  blank: (match: string) => Row,
): Row[] {
  if (!domain) return rows.filter((row) => !isPlaceholder(row))
  const domainValues = new Set(domain.map((option) => option.value))
  const kept = rows.filter((row) => domainValues.has(row.match) || !isPlaceholder(row))
  const present = new Set(kept.map((row) => row.match))
  return [...kept, ...domain.filter((option) => !present.has(option.value)).map((option) => blank(option.value))]
}

export function alignValueRows(rows: readonly ValueRowForm[], domain: readonly ValueOption[] | null): ValueRowForm[] {
  return alignRows(rows, domain, isValuePlaceholder, (match) => ({ match, text: '' }))
}

export function alignPermittedRows(rows: readonly PermittedRowForm[], domain: readonly ValueOption[] | null): PermittedRowForm[] {
  return alignRows(rows, domain, isPermittedPlaceholder, (match) => ({ match, values: [], default: '' }))
}

/** Allows or removes a value, keeping the values in domain order and the default among them. */
export function togglePermittedValue(row: PermittedRowForm, value: string, domain: readonly ValueOption[]): PermittedRowForm {
  const selected = new Set(row.values)
  if (selected.has(value)) selected.delete(value)
  else selected.add(value)
  const values = domain.map((option) => option.value).filter((entry) => selected.has(entry))
  const extra = [...selected].filter((entry) => !values.includes(entry))
  const ordered = [...values, ...extra]
  return { ...row, values: ordered, default: ordered.includes(row.default) ? row.default : (ordered[0] ?? '') }
}

export function defaultKeyedBy(definition: StudioDefinition): string {
  const features = sortByOrder(definition.features)
  return (features.find((feature) => feature.type !== 'number') ?? features[0])?.key ?? ''
}

export function lookupToForm(lookup: Lookup | undefined, definition: StudioDefinition, t: TranslateFn): LookupFormValues {
  const keyedBy = lookup?.keyedBy ?? defaultKeyedBy(definition)
  const domain = keyDomain(definition, keyedBy, t)
  const valueRows = lookup?.kind === 'value' ? lookup.rows.map((row) => ({ match: row.match, text: String(row.value), original: row.value, storedMatch: row.match })) : []
  const permittedRows = lookup?.kind === 'permitted' ? lookup.rows.map((row) => ({
          match: row.match,
          values: [...row.values],
          default: row.default,
          saved: true,
          storedEmpty: row.values.length === 0,
          storedMatch: row.match,
        })) : []
  return {
    label: lookup?.label ?? '',
    key: lookup?.key ?? '',
    kind: lookup?.kind ?? 'value',
    keyedBy,
    valueRows: alignValueRows(valueRows, domain),
    permittedRows: alignPermittedRows(permittedRows, domain),
  }
}

function canonicalNumber(text: string): number | null {
  const parsed = toFiniteNumber(text)
  return parsed !== null && String(parsed) === text ? parsed : null
}

/**
 * An untouched row keeps its stored value. Text in canonical number form ("40", "1.5") is stored as a number;
 * other text ("007", "1.50", SKUs) is stored as typed, and formulas still read numeric text as a number.
 */
export function rowValue(row: ValueRowForm, skuValues: boolean): string | number {
  if (isUntouchedValueRow(row)) return row.original ?? row.text
  const text = row.text.trim()
  if (skuValues) return text
  return canonicalNumber(text) ?? text
}

function checkMatch(
  row: { match: string; storedMatch?: string },
  index: number,
  seen: Set<string>,
  domainValues: Set<string>,
  errors: LookupFormErrors,
) {
  const { match } = row
  const field = `rows.${index}.match`
  if (match.trim() === '') errors[field] = LOOKUP_ERROR_KEYS.required
  else if (seen.has(match)) errors[field] = LOOKUP_ERROR_KEYS.duplicateMatch
  else if (match !== match.trim() && match !== row.storedMatch && !domainValues.has(match)) errors[field] = LOOKUP_ERROR_KEYS.matchSpaces
  seen.add(match)
}

function buildValueRows(values: LookupFormValues, domainValues: Set<string>, skuValues: boolean, errors: LookupFormErrors) {
  const seen = new Set<string>()
  const rows: Array<{ match: string; value: string | number }> = []
  values.valueRows.forEach((row, index) => {
    const { match } = row
    const blank = !valueRowHasValue(row)
    if (blank && domainValues.has(match)) return
    checkMatch(row, index, seen, domainValues, errors)
    if (blank) errors[`rows.${index}.value`] = LOOKUP_ERROR_KEYS.required
    rows.push({ match, value: rowValue(row, skuValues) })
  })
  return rows
}

function buildPermittedRows(values: LookupFormValues, domainValues: Set<string>, errors: LookupFormErrors) {
  const seen = new Set<string>()
  const rows: Array<{ match: string; values: string[]; default: string }> = []
  values.permittedRows.forEach((row, index) => {
    const { match } = row
    const blank = row.values.length === 0
    if (blank && !row.storedEmpty && domainValues.has(match)) return
    checkMatch(row, index, seen, domainValues, errors)
    if (blank && !row.storedEmpty) errors[`rows.${index}.values`] = LOOKUP_ERROR_KEYS.valuesRequired
    else if (!blank && !row.values.includes(row.default)) errors[`rows.${index}.default`] = LOOKUP_ERROR_KEYS.defaultNotAllowed
    rows.push({ match, values: row.values, default: row.default })
  })
  return rows
}

/**
 * Builds a schema-valid lookup from the row editor, or the field errors that stop it. Options of the key
 * feature left blank get no row (coverage warns about them); any other blank row is a field error, except a
 * permitted row stored with no values, which is kept as stored. Rows keep their order and matches are saved
 * exactly, since the evaluator matches selections exactly: a typed match with spaces at the start or end is
 * refused unless it is an option of the key feature, while a stored one is kept.
 */
export function formToLookup(
  values: LookupFormValues,
  options: { definition: StudioDefinition; domain: readonly ValueOption[] | null; otherKeys: readonly string[]; skuValues: boolean },
): LookupFormResult {
  const errors: LookupFormErrors = {}
  const key = values.key.trim()
  const label = values.label.trim()
  if (!key) errors.key = LOOKUP_ERROR_KEYS.required
  else if (options.otherKeys.includes(key)) errors.key = LOOKUP_ERROR_KEYS.duplicateKey
  if (!values.keyedBy) errors.keyedBy = LOOKUP_ERROR_KEYS.required
  else if (!options.definition.features.some((feature) => feature.key === values.keyedBy)) errors.keyedBy = LOOKUP_ERROR_KEYS.unknownFeature

  const domainValues = new Set((options.domain ?? []).map((option) => option.value))
  const rows =
    values.kind === 'value'
      ? buildValueRows(values, domainValues, options.skuValues, errors)
      : buildPermittedRows(values, domainValues, errors)
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const parsed = lookupSchema.safeParse({ kind: values.kind, key, ...(label ? { label } : {}), keyedBy: values.keyedBy, rows })
  if (parsed.success) return { ok: true, lookup: parsed.data }
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'key')
    if (!errors[field]) errors[field] = field === 'key' ? LOOKUP_ERROR_KEYS.invalidKey : LOOKUP_ERROR_KEYS.invalid
  }
  return { ok: false, errors }
}

/** Index of the first row with an error, so the row editor can show its page. */
export function firstErrorRow(errors: LookupFormErrors): number | null {
  let first: number | null = null
  for (const field of Object.keys(errors)) {
    const match = /^rows\.(\d+)\./.exec(field)
    if (!match) continue
    const index = Number(match[1])
    if (first === null || index < first) first = index
  }
  return first
}
