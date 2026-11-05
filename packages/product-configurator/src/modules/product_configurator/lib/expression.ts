import { DEFINITION_LIMITS, type Expression } from '../data/validators'
import type { EvaluationContext } from './evaluator/context'
import { ConfiguratorEvaluationError } from './evaluator/errors'
import { selectionKey, toFiniteNumber } from './values'

export function evaluateExpression(expression: Expression, context: EvaluationContext, formulaKey: string): number {
  const result = evaluateNode(expression, context, formulaKey, 1)
  if (!Number.isFinite(result)) {
    throw new ConfiguratorEvaluationError('expression_error', { reason: 'non_numeric', formulaKey })
  }
  return result
}

function evaluateNode(expression: Expression, context: EvaluationContext, formulaKey: string, depth: number): number {
  if (depth > DEFINITION_LIMITS.expressionDepth) {
    throw new ConfiguratorEvaluationError('expression_error', { reason: 'too_deep', formulaKey })
  }
  switch (expression.kind) {
    case 'const':
      return expression.value
    case 'feature': {
      if (!context.index.features.has(expression.featureKey)) {
        throw new ConfiguratorEvaluationError('expression_error', {
          reason: 'unknown_reference',
          formulaKey,
          featureKey: expression.featureKey,
        })
      }
      const value = context.selections[expression.featureKey]
      const numeric = toFiniteNumber(value)
      if (numeric === null) {
        throw new ConfiguratorEvaluationError('expression_error', {
          reason: 'non_numeric',
          formulaKey,
          featureKey: expression.featureKey,
          value: value ?? null,
        })
      }
      return numeric
    }
    case 'formula':
      return context.formula(expression.formulaKey)
    case 'lookup':
      return lookupNumber(expression.lookupKey, context, formulaKey)
    case 'op': {
      const left = evaluateNode(expression.left, context, formulaKey, depth + 1)
      const right = evaluateNode(expression.right, context, formulaKey, depth + 1)
      switch (expression.op) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          if (right === 0) {
            throw new ConfiguratorEvaluationError('expression_error', { reason: 'division_by_zero', formulaKey })
          }
          return left / right
      }
    }
  }
}

function lookupNumber(lookupKey: string, context: EvaluationContext, formulaKey: string): number {
  const lookup = context.index.lookups.get(lookupKey)
  if (lookup?.kind !== 'value') {
    throw new ConfiguratorEvaluationError('expression_error', { reason: 'unknown_reference', formulaKey, lookupKey })
  }
  const row = context.valueRow(lookupKey, lookup.keyedBy)
  if (!row) {
    throw new ConfiguratorEvaluationError('expression_error', {
      reason: 'lookup_row_missing',
      formulaKey,
      lookupKey,
      value: selectionKey(context.selections[lookup.keyedBy]),
    })
  }
  const numeric = toFiniteNumber(row.value)
  if (numeric === null) {
    throw new ConfiguratorEvaluationError('expression_error', {
      reason: 'non_numeric',
      formulaKey,
      lookupKey,
      value: row.value,
    })
  }
  return numeric
}
