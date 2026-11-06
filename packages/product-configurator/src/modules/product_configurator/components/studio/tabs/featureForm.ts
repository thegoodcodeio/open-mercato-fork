import type { Condition, Feature, FeatureType } from '../../../data/validators'
import { featureSchema } from '../../../data/validators'
import { numberValueIssue } from '../../../lib/evaluator/structure'
import { toFiniteNumber } from '../../../lib/values'

export type FeatureFormOption = { label: string; value: string; swatch: string; order: string }

export type FeatureFormValues = {
  label: string
  key: string
  type: FeatureType
  options: FeatureFormOption[]
  /** Permitted lookup that limits the options per selection; empty when none. */
  optionsFromLookup: string
  min: string
  max: string
  step: string
  unit: string
  group: string
  order: string
  defaultValue: string
  inSummary: boolean
  visibleWhen: Condition[]
}

/** Field id (`key`, `options.2.swatch`, ...) -> i18n key of the message. */
export type FeatureFormErrors = Record<string, string>

export type FeatureFormResult = { ok: true; feature: Feature } | { ok: false; errors: FeatureFormErrors }

const ERROR_PREFIX = 'product_configurator.studio.features.errors.'

export const FEATURE_ERROR_KEYS = {
  required: `${ERROR_PREFIX}required`,
  number: `${ERROR_PREFIX}number`,
  integer: `${ERROR_PREFIX}integer`,
  invalidKey: `${ERROR_PREFIX}invalidKey`,
  duplicateKey: `${ERROR_PREFIX}duplicateKey`,
  duplicateOption: `${ERROR_PREFIX}duplicateOption`,
  optionsRequired: `${ERROR_PREFIX}optionsRequired`,
  swatch: `${ERROR_PREFIX}swatch`,
  minAboveMax: `${ERROR_PREFIX}minAboveMax`,
  step: `${ERROR_PREFIX}step`,
  defaultOutOfRange: `${ERROR_PREFIX}defaultOutOfRange`,
  defaultOffStep: `${ERROR_PREFIX}defaultOffStep`,
  invalid: `${ERROR_PREFIX}invalid`,
} as const

const SCHEMA_MESSAGE_ERRORS: Record<string, string> = {
  options_required: FEATURE_ERROR_KEYS.optionsRequired,
  swatch_required: FEATURE_ERROR_KEYS.swatch,
  min_above_max: FEATURE_ERROR_KEYS.minAboveMax,
  reserved_key: FEATURE_ERROR_KEYS.invalidKey,
}

const EMPTY_FORM: Omit<FeatureFormValues, 'order'> = {
  label: '',
  key: '',
  type: 'choice',
  options: [],
  optionsFromLookup: '',
  min: '',
  max: '',
  step: '',
  unit: '',
  group: '',
  defaultValue: '',
  inSummary: true,
  visibleWhen: [],
}

function text(value: number | string | undefined): string {
  return value === undefined ? '' : String(value)
}

export function nextFeatureOrder(features: readonly Feature[]): number {
  return features.reduce((highest, feature) => Math.max(highest, feature.order), 0) + 10
}

export function featureToForm(feature: Feature | undefined, nextOrder: number): FeatureFormValues {
  if (!feature) return { ...EMPTY_FORM, order: String(nextOrder) }
  return {
    label: feature.label,
    key: feature.key,
    type: feature.type,
    options: (feature.options ?? []).map((option) => ({
      label: option.label,
      value: option.value,
      swatch: option.swatch ?? '',
      order: String(option.order),
    })),
    optionsFromLookup: feature.optionsFromLookup ?? '',
    min: text(feature.min),
    max: text(feature.max),
    step: text(feature.step),
    unit: feature.unit ?? '',
    group: feature.group ?? '',
    order: String(feature.order),
    defaultValue: String(feature.default),
    inSummary: feature.inSummary,
    visibleWhen: feature.visibleWhen ?? [],
  }
}

/** A value for an option typed with a label only: "Signal red" -> "signal_red". */
export function suggestOptionValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function optionalNumber(raw: string, field: string, errors: FeatureFormErrors): number | undefined {
  if (!raw.trim()) return undefined
  const parsed = toFiniteNumber(raw)
  if (parsed !== null) return parsed
  errors[field] = FEATURE_ERROR_KEYS.number
  return undefined
}

function requiredInteger(raw: string, field: string, errors: FeatureFormErrors): number {
  const parsed = toFiniteNumber(raw)
  if (parsed !== null && Number.isInteger(parsed)) return parsed
  errors[field] = FEATURE_ERROR_KEYS.integer
  return 0
}

/** Option values are referenced by rules, lookups and conditions, so they are kept exactly as typed. */
function buildOptions(values: FeatureFormValues, errors: FeatureFormErrors): NonNullable<Feature['options']> {
  const seen = new Set<string>()
  return values.options.map((option, index) => {
    const label = option.label.trim()
    const value = option.value.trim() ? option.value : suggestOptionValue(label)
    if (!label) errors[`options.${index}.label`] = FEATURE_ERROR_KEYS.required
    if (!value) errors[`options.${index}.value`] = FEATURE_ERROR_KEYS.required
    if (value && seen.has(value)) errors[`options.${index}.value`] = FEATURE_ERROR_KEYS.duplicateOption
    seen.add(value)
    const order = requiredInteger(option.order, `options.${index}.order`, errors)
    const swatch = option.swatch.trim()
    if ((values.type === 'color' || swatch) && !/^#[0-9A-Fa-f]{6}$/.test(swatch)) errors[`options.${index}.swatch`] = FEATURE_ERROR_KEYS.swatch
    return swatch ? { value, label, order, swatch } : { value, label, order }
  })
}

function buildDefault(values: FeatureFormValues, errors: FeatureFormErrors): Feature['default'] {
  if (values.type === 'boolean') return values.defaultValue === 'true'
  if (values.type !== 'number') return values.defaultValue
  const parsed = toFiniteNumber(values.defaultValue)
  if (parsed !== null) return parsed
  errors.default = FEATURE_ERROR_KEYS.number
  return 0
}

function schemaErrors(candidate: unknown, errors: FeatureFormErrors): Feature | null {
  const parsed = featureSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    const [field, index, sub] = issue.path.map(String)
    const id = field === 'options' && index !== undefined ? `options.${index}${sub ? `.${sub}` : ''}` : (field ?? 'key')
    const target = field === 'step' ? FEATURE_ERROR_KEYS.step : SCHEMA_MESSAGE_ERRORS[issue.message]
    if (!errors[id]) errors[id] = target ?? (id === 'key' ? FEATURE_ERROR_KEYS.invalidKey : FEATURE_ERROR_KEYS.invalid)
  }
  return null
}

/**
 * Builds a schema-valid feature from the row editor, or the field errors that stop it. An empty `options` or
 * `visibleWhen` list of `original` is kept while the form leaves it empty, so saving an untouched row changes nothing.
 */
export function formToFeature(values: FeatureFormValues, otherKeys: readonly string[], original?: Feature): FeatureFormResult {
  const errors: FeatureFormErrors = {}
  const label = values.label.trim()
  const key = values.key.trim()
  if (!label) errors.label = FEATURE_ERROR_KEYS.required
  if (!key) errors.key = FEATURE_ERROR_KEYS.required
  else if (otherKeys.includes(key)) errors.key = FEATURE_ERROR_KEYS.duplicateKey

  const hasOptions = values.type === 'choice' || values.type === 'color'
  const fromLookup = hasOptions && values.optionsFromLookup !== ''
  if (hasOptions && !fromLookup && values.options.length === 0) errors.options = FEATURE_ERROR_KEYS.optionsRequired
  const keepsEmptyOptions = hasOptions && values.options.length === 0 && original?.options?.length === 0
  const options = hasOptions && (values.options.length > 0 || keepsEmptyOptions) ? buildOptions(values, errors) : undefined
  const isNumber = values.type === 'number'
  const min = isNumber ? optionalNumber(values.min, 'min', errors) : undefined
  const max = isNumber ? optionalNumber(values.max, 'max', errors) : undefined
  const step = isNumber ? optionalNumber(values.step, 'step', errors) : undefined
  const order = requiredInteger(values.order, 'order', errors)
  const defaultValue = buildDefault(values, errors)
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const unit = values.unit.trim()
  const group = values.group.trim()
  const keepsEmptyVisibleWhen = values.visibleWhen.length === 0 && original?.visibleWhen?.length === 0
  const candidate = {
    key,
    label,
    type: values.type,
    ...(options ? { options } : {}),
    ...(fromLookup ? { optionsFromLookup: values.optionsFromLookup } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(unit ? { unit } : {}),
    ...(group ? { group } : {}),
    default: defaultValue,
    order,
    inSummary: values.inSummary,
    ...(values.visibleWhen.length > 0 || keepsEmptyVisibleWhen ? { visibleWhen: values.visibleWhen } : {}),
  }
  const feature = schemaErrors(candidate, errors)
  if (!feature) return { ok: false, errors }
  const defaultIssue = typeof feature.default === 'number' ? numberValueIssue(feature, feature.default) : null
  if (defaultIssue) {
    return { ok: false, errors: { default: defaultIssue === 'step' ? FEATURE_ERROR_KEYS.defaultOffStep : FEATURE_ERROR_KEYS.defaultOutOfRange } }
  }
  return { ok: true, feature }
}
