import { DEFINITION_LIMITS, type Expression } from '../../data/validators'
import { createContext, indexDefinition } from '../evaluator/context'
import { ConfiguratorEvaluationError } from '../evaluator/errors'
import { evaluateExpression } from '../expression'
import type { Selections } from '../values'
import { build } from './fixtures'

const definition = build((input) => {
  input.features.push({
    key: 'boom',
    label: 'Boom',
    type: 'choice',
    options: [
      { value: '8', label: '8 m', order: 1 },
      { value: 'long', label: 'Long', order: 2 },
    ],
    default: '8',
    order: 7,
    inSummary: false,
  })
  input.lookups.push({
    kind: 'value',
    key: 'labels',
    keyedBy: 'motor',
    rows: [{ match: 'standard', value: 'n/a' }],
  })
  input.formulas.push(
    { key: 'loop_a', expr: { kind: 'formula', formulaKey: 'loop_b' } },
    { key: 'loop_b', expr: { kind: 'formula', formulaKey: 'loop_a' } },
  )
})

const defaults: Selections = { motor: 'standard', length: 2, cover: false, color: 'red', seal: 'epdm', remote: false, boom: '8' }

function evaluate(expression: Expression, selections: Selections = {}): number {
  const context = createContext(indexDefinition(definition), { ...defaults, ...selections })
  return evaluateExpression(expression, context, 'subject')
}

function expressionError(run: () => unknown): ConfiguratorEvaluationError {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfiguratorEvaluationError) return error
    throw error
  }
  throw new Error('expected a ConfiguratorEvaluationError')
}

const op = (operator: '+' | '-' | '*' | '/', left: Expression, right: Expression): Expression => ({
  kind: 'op',
  op: operator,
  left,
  right,
})
const value = (number: number): Expression => ({ kind: 'const', value: number })

describe('evaluateExpression', () => {
  it('evaluates constants, features, formulas, lookups and the four operators', () => {
    expect(evaluate(op('-', op('*', value(3), value(4)), op('/', value(10), value(4))))).toBe(9.5)
    expect(evaluate({ kind: 'feature', featureKey: 'length' }, { length: 7.5 })).toBe(7.5)
    expect(evaluate({ kind: 'feature', featureKey: 'boom' })).toBe(8)
    expect(evaluate({ kind: 'formula', formulaKey: 'pipe_meters' })).toBe(2.25)
    expect(evaluate({ kind: 'lookup', lookupKey: 'motor_weight' }, { motor: 'heavy' })).toBe(65.5)
    expect(evaluate(op('+', { kind: 'lookup', lookupKey: 'motor_weight' }, value(1)))).toBe(41)
  })

  it('fails with expression_error on division by zero', () => {
    const error = expressionError(() => evaluate(op('/', value(1), op('-', value(2), value(2)))))
    expect(error.code).toBe('expression_error')
    expect(error.params).toEqual({ reason: 'division_by_zero', formulaKey: 'subject' })
  })

  it('fails with expression_error on a missing lookup row', () => {
    const error = expressionError(() => evaluate({ kind: 'lookup', lookupKey: 'labels' }, { motor: 'heavy' }))
    expect(error.params).toEqual({ reason: 'lookup_row_missing', formulaKey: 'subject', lookupKey: 'labels', value: 'heavy' })
  })

  it('fails with expression_error on non-numeric input', () => {
    expect(expressionError(() => evaluate({ kind: 'feature', featureKey: 'boom' }, { boom: 'long' })).params).toEqual({
      reason: 'non_numeric',
      formulaKey: 'subject',
      featureKey: 'boom',
      value: 'long',
    })
    expect(expressionError(() => evaluate({ kind: 'feature', featureKey: 'cover' })).params.reason).toBe('non_numeric')
    expect(expressionError(() => evaluate({ kind: 'lookup', lookupKey: 'labels' })).params.reason).toBe('non_numeric')
    expect(expressionError(() => evaluate(op('*', value(1e308), value(10)))).params.reason).toBe('non_numeric')
  })

  it('fails with expression_error on unknown references and formula cycles', () => {
    expect(expressionError(() => evaluate({ kind: 'feature', featureKey: 'ghost' })).params.reason).toBe('unknown_reference')
    expect(expressionError(() => evaluate({ kind: 'lookup', lookupKey: 'seals_by_motor' })).params.reason).toBe(
      'unknown_reference',
    )
    expect(expressionError(() => evaluate({ kind: 'formula', formulaKey: 'ghost' })).params.reason).toBe('unknown_reference')
    expect(expressionError(() => evaluate({ kind: 'formula', formulaKey: 'loop_a' })).params.reason).toBe('formula_cycle')
  })

  it('fails with expression_error instead of overflowing the stack on an expression deeper than the limit', () => {
    const nest = (depth: number): Expression => (depth <= 1 ? value(1) : op('+', nest(depth - 1), value(1)))
    expect(evaluate(nest(DEFINITION_LIMITS.expressionDepth))).toBe(DEFINITION_LIMITS.expressionDepth)
    expect(expressionError(() => evaluate(nest(DEFINITION_LIMITS.expressionDepth + 1))).params).toEqual({
      reason: 'too_deep',
      formulaKey: 'subject',
    })
  })
})
