import type { Condition, SelectionValue } from '../data/validators'
import { INCLUDES_TOKEN_SEPARATOR } from '../data/validators'
import type { EvaluationContext } from './evaluator/context'
import { selectionKey, toFiniteNumber } from './values'

type OrderingOp = 'gt' | 'gte' | 'lt' | 'lte'

export function tokenize(value: SelectionValue | null | undefined): string[] {
  return selectionKey(value)
    .split(INCLUDES_TOKEN_SEPARATOR)
    .filter((token) => token.length > 0)
}

export function conditionsHold(conditions: readonly Condition[] | undefined, context: EvaluationContext): boolean {
  return (conditions ?? []).every((condition) => conditionHolds(condition, context))
}

export function conditionHolds(condition: Condition, context: EvaluationContext): boolean {
  switch (condition.kind) {
    case 'compare': {
      const actual = context.selections[condition.featureKey]
      if (condition.op === 'eq') return selectionKey(actual) === selectionKey(condition.value)
      if (condition.op === 'neq') return selectionKey(actual) !== selectionKey(condition.value)
      const left = toFiniteNumber(actual)
      const right = toFiniteNumber(condition.value)
      return left !== null && right !== null && compareNumbers(left, condition.op, right)
    }
    case 'includes':
      return tokenize(context.selections[condition.featureKey]).includes(condition.value)
    case 'not_includes':
      return !tokenize(context.selections[condition.featureKey]).includes(condition.value)
    case 'not_in_lookup': {
      const value = selectionKey(context.selections[condition.featureKey])
      return !allowedLookupValues(condition.lookupKey, condition.keyedBy, context).includes(value)
    }
    case 'calculated':
      return compareNumbers(context.formula(condition.formulaKey), condition.op, condition.value)
  }
}

function allowedLookupValues(lookupKey: string, keyedBy: string, context: EvaluationContext): string[] {
  const permitted = context.permittedRow(lookupKey, keyedBy)
  if (permitted) return permitted.values
  const valueRow = context.valueRow(lookupKey, keyedBy)
  return valueRow ? [String(valueRow.value)] : []
}

function compareNumbers(left: number, op: OrderingOp, right: number): boolean {
  switch (op) {
    case 'gt':
      return left > right
    case 'gte':
      return left >= right
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
  }
}
