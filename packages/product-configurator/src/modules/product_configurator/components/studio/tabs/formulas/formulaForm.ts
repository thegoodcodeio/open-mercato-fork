import { FORMULA_MAX_DECIMALS, formulaSchema, type Formula } from '../../../../data/validators'
import { createContext, indexDefinition } from '../../../../lib/evaluator/context'
import { ConfiguratorEvaluationError } from '../../../../lib/evaluator/errors'
import { normaliseSelections, settle } from '../../../../lib/evaluator/structure'
import { formatExpression } from '../../../../lib/exprFormat'
import {
  expressionReferenceKeys,
  parseExpression,
  type ExpressionParseError,
  type ExpressionReferenceKeys,
} from '../../../../lib/exprParse'
import { sortByOrder, type Selections } from '../../../../lib/values'
import type { StudioDefinition } from '../types'

export type FormulaFormValues = {
  label: string
  key: string
  expression: string
  unit: string
  /** `''` leaves `decimals` unset (the engine then keeps up to 6). */
  decimals: string
}

/** Field (`label`, `key`, `decimals`) -> i18n key of the message. Expression errors come from the parser. */
export type FormulaFormErrors = Partial<Record<'key' | 'decimals', string>>

export type FormulaFormResult =
  | { ok: true; formula: Formula }
  | { ok: false; errors: FormulaFormErrors; expressionError: ExpressionParseError | null }

export const FORMULA_DECIMAL_CHOICES: readonly string[] = Array.from({ length: FORMULA_MAX_DECIMALS + 1 }, (_, index) => String(index))

const FEATURE_ERRORS = 'product_configurator.studio.features.errors.'

export const FORMULA_ERROR_KEYS = {
  required: `${FEATURE_ERRORS}required`,
  invalidKey: `${FEATURE_ERRORS}invalidKey`,
  duplicateKey: 'product_configurator.studio.formulas.errors.duplicateKey',
  decimals: 'product_configurator.studio.formulas.errors.decimals',
} as const

export const FORMULA_ERROR_FALLBACKS: Record<string, string> = {
  [FORMULA_ERROR_KEYS.required]: 'Required.',
  [FORMULA_ERROR_KEYS.invalidKey]: 'Use letters, digits and _ only, starting with a letter or _.',
  [FORMULA_ERROR_KEYS.duplicateKey]: 'Another formula already uses this key.',
  [FORMULA_ERROR_KEYS.decimals]: 'Pick 0 to 6 decimals.',
}

export function formulaToForm(formula: Formula | undefined): FormulaFormValues {
  if (!formula) return { label: '', key: '', expression: '', unit: '', decimals: '' }
  return {
    label: formula.label ?? '',
    key: formula.key,
    expression: formatExpression(formula.expr),
    unit: formula.unit ?? '',
    decimals: formula.decimals === undefined ? '' : String(formula.decimals),
  }
}

/** Keys an expression of the formula `ownKey` may read: every feature and lookup, and the other formulas (a formula cannot read itself). */
export function formulaReferenceKeys(definition: StudioDefinition, ownKey: string | undefined): ExpressionReferenceKeys {
  const keys = expressionReferenceKeys(definition)
  return { ...keys, formula: new Set([...keys.formula].filter((key) => key !== ownKey)) }
}

function decimalsValue(raw: string): number | undefined | null {
  if (raw === '') return undefined
  return FORMULA_DECIMAL_CHOICES.includes(raw) ? Number(raw) : null
}

/** Builds a schema-valid formula from the row editor, or the errors that stop it. */
export function formToFormula(
  values: FormulaFormValues,
  otherKeys: readonly string[],
  references: ExpressionReferenceKeys,
): FormulaFormResult {
  const errors: FormulaFormErrors = {}
  const key = values.key.trim()
  if (!key) errors.key = FORMULA_ERROR_KEYS.required
  else if (otherKeys.includes(key)) errors.key = FORMULA_ERROR_KEYS.duplicateKey
  const decimals = decimalsValue(values.decimals)
  if (decimals === null) errors.decimals = FORMULA_ERROR_KEYS.decimals
  const parsed = parseExpression(values.expression, { references })
  const expressionError = parsed.ok ? null : parsed.error
  if (!parsed.ok || Object.keys(errors).length > 0) return { ok: false, errors, expressionError }

  const label = values.label.trim()
  const unit = values.unit.trim()
  const candidate = {
    key,
    ...(label ? { label } : {}),
    expr: parsed.expression,
    ...(unit ? { unit } : {}),
    ...(decimals !== undefined && decimals !== null ? { decimals } : {}),
  }
  const result = formulaSchema.safeParse(candidate)
  if (result.success) return { ok: true, formula: result.data }
  return { ok: false, errors: { key: FORMULA_ERROR_KEYS.invalidKey }, expressionError: null }
}

/**
 * Value of every formula for the model defaults: default selections settled by visibility and
 * force rules, like the evaluator does, then each formula on its own so one broken formula does
 * not hide the others. `null` when the value cannot be computed (unknown reference, missing lookup
 * row, division by zero, cycle, or a draft whose defaults do not settle).
 */
export function previewFormulas(definition: StudioDefinition): Map<string, number | null> {
  const previews = new Map<string, number | null>()
  const index = indexDefinition(definition)
  let selections: Selections
  try {
    selections = settle(index, sortByOrder(definition.features), normaliseSelections(index, {})).selections
  } catch (error) {
    if (!(error instanceof ConfiguratorEvaluationError)) throw error
    for (const formula of definition.formulas) previews.set(formula.key, null)
    return previews
  }
  const context = createContext(index, selections)
  for (const formula of definition.formulas) {
    try {
      previews.set(formula.key, context.formula(formula.key))
    } catch (error) {
      if (!(error instanceof ConfiguratorEvaluationError)) throw error
      previews.set(formula.key, null)
    }
  }
  return previews
}

/** Preview of one formula as it would be saved: the draft with `formula` in place of `originalKey` (or added). */
export function previewCandidate(definition: StudioDefinition, formula: Formula, originalKey: string | undefined): number | null {
  const formulas = originalKey
    ? definition.formulas.map((entry) => (entry.key === originalKey ? formula : entry))
    : [...definition.formulas.filter((entry) => entry.key !== formula.key), formula]
  return previewFormulas({ ...definition, formulas }).get(formula.key) ?? null
}

/** "86.33 kNm": the value with the formula's decimals and unit, or an em dash when it cannot be computed. */
export function formatPreview(value: number | null, decimals: number | undefined, unit: string | undefined): string {
  if (value === null) return '—'
  const number = decimals === undefined ? String(value) : value.toFixed(decimals)
  return unit ? `${number} ${unit}` : number
}
