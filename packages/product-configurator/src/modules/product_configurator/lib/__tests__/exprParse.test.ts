import { DEFINITION_LIMITS, type Expression } from '../../data/validators'
import {
  EXPRESSION_PARSE_ERROR_CODES,
  applyExpressionEdit,
  closeMatchForError,
  expressionReferenceKeys,
  numericExpressionReferences,
  parseExpression,
  suggestExpressionReferences,
  type ExpressionParseError,
  type ExpressionParseErrorCode,
  type ExpressionReference,
} from '../exprParse'
import { build } from './fixtures'

const feature = (featureKey: string): Expression => ({ kind: 'feature', featureKey })
const constant = (value: number): Expression => ({ kind: 'const', value })
const op = (operator: '+' | '-' | '*' | '/', left: Expression, right: Expression): Expression => ({
  kind: 'op',
  op: operator,
  left,
  right,
})

function parsed(text: string): Expression {
  const result = parseExpression(text)
  if (!result.ok) throw new Error(`[internal] ${text}: ${result.error.code} at ${result.error.position}`)
  return result.expression
}

function failure(text: string, references?: Parameters<typeof parseExpression>[1]): ExpressionParseError {
  const result = parseExpression(text, references)
  if (result.ok) throw new Error(`[internal] expected ${text} to fail`)
  return result.error
}

const model = {
  features: [
    { key: 'boom_reach', label: 'Boom reach', type: 'number' as const, default: 8, order: 1, inSummary: true },
    {
      key: 'motor',
      label: 'Motor',
      type: 'choice' as const,
      options: [{ value: 'standard', label: 'Standard', order: 1 }],
      default: 'standard',
      order: 2,
      inSummary: true,
    },
    {
      key: 'panels',
      label: 'Panel count',
      type: 'choice' as const,
      options: [
        { value: '2', label: 'Two', order: 1 },
        { value: '4', label: 'Four', order: 2 },
      ],
      default: '2',
      order: 3,
      inSummary: true,
    },
    { key: 'sizes', label: 'Size', type: 'choice' as const, optionsFromLookup: 'size_options', default: '10', order: 4, inSummary: true },
    { key: 'heated', label: 'Heated', type: 'boolean' as const, default: false, order: 5, inSummary: true },
  ],
  formulas: [
    { key: 'area', label: 'Panel area', expr: constant(1) },
    { key: 'total_weight', expr: constant(2) },
  ],
  lookups: [
    { kind: 'value' as const, key: 'weight', label: 'Weight per metre', keyedBy: 'motor', rows: [{ match: 'standard', value: '1.5' }] },
    { kind: 'value' as const, key: 'motor_sku', keyedBy: 'motor', rows: [{ match: 'standard', value: 'SKU-1' }] },
    { kind: 'permitted' as const, key: 'size_options', keyedBy: 'motor', rows: [{ match: 'standard', values: ['10', '12'], default: '10' }] },
  ],
}

const references = numericExpressionReferences(model)

describe('parseExpression', () => {
  it('parses references, numbers and the spec example', () => {
    expect(parsed('feature.boom_reach * lookup.weight / 2')).toEqual(
      op('/', op('*', feature('boom_reach'), { kind: 'lookup', lookupKey: 'weight' }), constant(2)),
    )
    expect(parsed('formula.area')).toEqual({ kind: 'formula', formulaKey: 'area' })
    expect(parsed('3.25')).toEqual(constant(3.25))
    expect(parsed('.5')).toEqual(constant(0.5))
    expect(parsed('1.5e3 + 2E-2')).toEqual(op('+', constant(1500), constant(0.02)))
    expect(parsed('1e+5')).toEqual(constant(100000))
    expect(parsed('1E-3')).toEqual(constant(0.001))
  })

  it('applies normal precedence and left associativity', () => {
    expect(parsed('1 + 2 * 3')).toEqual(op('+', constant(1), op('*', constant(2), constant(3))))
    expect(parsed('1 * 2 + 3')).toEqual(op('+', op('*', constant(1), constant(2)), constant(3)))
    expect(parsed('8 - 3 - 2')).toEqual(op('-', op('-', constant(8), constant(3)), constant(2)))
    expect(parsed('8 / 4 / 2')).toEqual(op('/', op('/', constant(8), constant(4)), constant(2)))
    expect(parsed('1 - 2 * 3 / 4 + 5')).toEqual(
      op('+', op('-', constant(1), op('/', op('*', constant(2), constant(3)), constant(4))), constant(5)),
    )
  })

  it('respects parentheses and ignores whitespace', () => {
    expect(parsed('(1 + 2) * 3')).toEqual(op('*', op('+', constant(1), constant(2)), constant(3)))
    expect(parsed('8-(3-2)')).toEqual(op('-', constant(8), op('-', constant(3), constant(2))))
    expect(parsed('  ((( feature.a )))\n')).toEqual(feature('a'))
  })

  it('reads a minus before a number as a negative constant', () => {
    expect(parsed('-2')).toEqual(constant(-2))
    expect(parsed('- 2 * feature.a')).toEqual(op('*', constant(-2), feature('a')))
    expect(parsed('feature.a - -2')).toEqual(op('-', feature('a'), constant(-2)))
    expect(parsed('2-3')).toEqual(op('-', constant(2), constant(3)))
    expect(parsed('feature.a * -1')).toEqual(op('*', feature('a'), constant(-1)))
    expect(Object.is((parsed('-0') as { value: number }).value, -0)).toBe(true)
  })

  it('accepts known references when a reference list is given', () => {
    const result = parseExpression('feature.motor + lookup.motor_sku', { references: expressionReferenceKeys(model) })
    expect(result.ok).toBe(true)
  })

  const limit = DEFINITION_LIMITS.expressionDepth
  const deepChain = `1${' + 1'.repeat(limit)}`
  const deepParens = `${'('.repeat(limit + 1)}1${')'.repeat(limit + 1)}`
  const errorCases: Array<[ExpressionParseErrorCode, string, Partial<ExpressionParseError>]> = [
    ['empty_expression', '   ', { position: 0, length: 0, near: '' }],
    ['unexpected_token', 'feature.a $ 2', { position: 10, length: 1, near: '$' }],
    ['unexpected_token', 'feature.a feature.b', { position: 10, length: 9, near: 'feature.b' }],
    ['unexpected_token', '2 * * 3', { position: 4, length: 1, near: '*' }],
    ['unexpected_token', '()', { position: 1, length: 1, near: ')' }],
    ['unexpected_token', '(1 2)', { position: 3, length: 1, near: '2' }],
    ['unexpected_token', 'feature.a.b', { position: 9, length: 1, near: '.' }],
    ['unexpected_token', '1 😀', { position: 2, length: 2, near: '😀' }],
    ['unexpected_end', 'feature.a +', { position: 11, length: 0, near: '' }],
    ['unbalanced_paren', '(feature.a + 2', { position: 0, length: 1, near: '(' }],
    ['unbalanced_paren', '2 * ((1 + 2)', { position: 4, length: 1, near: '(' }],
    ['unbalanced_paren', 'feature.a + 2)', { position: 13, length: 1, near: ')' }],
    ['unbalanced_paren', ')', { position: 0, length: 1, near: ')' }],
    ['invalid_number', '1.2.3 + 1', { position: 0, length: 5, near: '1.2.3' }],
    ['invalid_number', '2 * 3.', { position: 4, length: 2, near: '3.' }],
    ['invalid_number', '12abc', { position: 0, length: 5, near: '12abc' }],
    ['invalid_number', '1e999', { position: 0, length: 5, near: '1e999' }],
    ['missing_namespace', '2 * boom_reach', { position: 4, length: 10, near: 'boom_reach', params: { key: 'boom_reach' } }],
    ['unknown_namespace', 'feat.boom', { position: 0, length: 9, near: 'feat.boom', params: { namespace: 'feat', key: 'boom' } }],
    ['invalid_key', 'feature.', { position: 0, length: 8, params: { namespace: 'feature', key: '' } }],
    ['invalid_key', 'lookup.2x', { position: 0, length: 9, params: { namespace: 'lookup', key: '2x' } }],
    ['invalid_key', 'feature.constructor', { position: 0, length: 19, params: { namespace: 'feature', key: 'constructor' } }],
    ['invalid_key', `formula.${'k'.repeat(65)}`, { position: 0, length: 73 }],
    ['unary_minus_unsupported', '-feature.a', { position: 0, length: 1, near: '-' }],
    ['unary_minus_unsupported', '2 * -(1 + 2)', { position: 4, length: 1, near: '-' }],
    ['unary_minus_unsupported', '--3', { position: 0, length: 1, near: '-' }],
    ['unary_minus_unsupported', '- -3', { position: 0, length: 1, near: '-' }],
    ['decimal_comma', '1,5', { position: 0, length: 3, near: '1,5' }],
    ['decimal_comma', 'feature.a * 2,75', { position: 12, length: 4, near: '2,75' }],
    ['unexpected_token', '1, 5', { position: 1, length: 1, near: ',' }],
    ['expression_too_deep', deepChain, { position: deepChain.lastIndexOf('+'), length: 1, params: { limit } }],
    ['expression_too_deep', deepParens, { position: limit, length: 1, near: '(', params: { limit } }],
  ]

  it.each(errorCases)('fails with %s for %j', (code, text, expected) => {
    const error = failure(text)
    expect(error).toMatchObject({ code, messageKey: `product_configurator.expression.errors.${code}`, ...expected })
  })

  it('reports an unknown reference only when a reference list is given', () => {
    const keys = expressionReferenceKeys(model)
    expect(parseExpression('feature.boom_rech * 2').ok).toBe(true)
    expect(failure('2 * feature.boom_rech', { references: keys })).toMatchObject({
      code: 'unknown_reference',
      position: 4,
      length: 17,
      near: 'feature.boom_rech',
      params: { namespace: 'feature', key: 'boom_rech' },
    })
    expect(failure('lookup.area', { references: keys })).toMatchObject({ code: 'unknown_reference' })
  })

  it('covers every error code', () => {
    const covered = new Set([...errorCases.map(([code]) => code), 'unknown_reference'])
    expect([...covered].sort((left, right) => left.localeCompare(right))).toEqual(
      [...EXPRESSION_PARSE_ERROR_CODES].sort((left, right) => left.localeCompare(right)),
    )
  })

  it('accepts a tree at the depth limit and redundant parentheses up to it', () => {
    expect(parseExpression(`1${' + 1'.repeat(limit - 1)}`).ok).toBe(true)
    expect(parseExpression(`${'('.repeat(limit)}1${')'.repeat(limit)}`).ok).toBe(true)
  })

  it('returns a typed error, not a stack overflow, for very deep input', () => {
    expect(failure('('.repeat(100_000)).code).toBe('expression_too_deep')
    expect(failure(`1${' + 1'.repeat(100_000)}`).code).toBe('expression_too_deep')
  })
})

describe('numericExpressionReferences', () => {
  it('lists numeric features, formulas and numeric value lookups with friendly names', () => {
    expect(references).toEqual([
      { namespace: 'feature', key: 'boom_reach', label: 'Boom reach' },
      { namespace: 'feature', key: 'panels', label: 'Panel count' },
      { namespace: 'feature', key: 'sizes', label: 'Size' },
      { namespace: 'formula', key: 'area', label: 'Panel area' },
      { namespace: 'formula', key: 'total_weight', label: 'total_weight' },
      { namespace: 'lookup', key: 'weight', label: 'Weight per metre' },
    ])
  })

  it('leaves out the formula being edited', () => {
    expect(numericExpressionReferences(model, { excludeFormulaKey: 'area' }).map((reference) => reference.key)).not.toContain('area')
  })

  it('works on the reference model fixture', () => {
    const keys = numericExpressionReferences(build())
    expect(keys.some((reference) => reference.namespace === 'feature' && reference.key === 'length')).toBe(true)
    expect(keys.some((reference) => reference.key === 'motor')).toBe(false)
  })
})

describe('suggestExpressionReferences', () => {
  const keysOf = (suggestions: readonly ExpressionReference[]) =>
    suggestions.map((suggestion) => `${suggestion.namespace}.${suggestion.key}`)

  it('matches by friendly name and by key, best match first', () => {
    expect(keysOf(suggestExpressionReferences('2 * pan', 7, references))).toEqual(['feature.panels', 'formula.area'])
    expect(keysOf(suggestExpressionReferences('weig', 4, references))).toEqual(['lookup.weight', 'formula.total_weight'])
    expect(keysOf(suggestExpressionReferences('metre', 5, references))).toEqual(['lookup.weight'])
    expect(keysOf(suggestExpressionReferences('REACH', 5, references))).toEqual(['feature.boom_reach'])
  })

  it('narrows to one kind after a namespace prefix', () => {
    expect(keysOf(suggestExpressionReferences('formula.', 8, references))).toEqual(['formula.area', 'formula.total_weight'])
    expect(keysOf(suggestExpressionReferences('feature.pa', 10, references))).toEqual(['feature.panels'])
    expect(suggestExpressionReferences('feat.pa', 7, references)).toEqual([])
  })

  it('offers nothing for numbers, operators or an empty word', () => {
    expect(suggestExpressionReferences('12', 2, references)).toEqual([])
    expect(suggestExpressionReferences('2 + ', 4, references)).toEqual([])
    expect(suggestExpressionReferences('.5', 2, references)).toEqual([])
  })

  it('replaces the whole word around the cursor with the key', () => {
    const text = 'feature.boom_reach * pan + 1'
    const [first] = suggestExpressionReferences(text, 23, references)
    expect(first).toMatchObject({ key: 'panels', from: 21, to: 24, insertText: 'feature.panels' })
    expect(applyExpressionEdit(text, first)).toEqual({ text: 'feature.boom_reach * feature.panels + 1', cursor: 35 })
  })

  it('honours the limit', () => {
    expect(suggestExpressionReferences('a', 1, references, 2)).toHaveLength(2)
  })
})

describe('closeMatchForError', () => {
  const keys = expressionReferenceKeys(model)
  const fix = (text: string) => {
    const error = failure(text, { references: keys })
    const match = closeMatchForError(error, references)
    return match ? applyExpressionEdit(text, match).text : null
  }

  it('fixes a typo in the key', () => {
    expect(fix('feature.boom_rech * 2')).toBe('feature.boom_reach * 2')
    expect(fix('formula.aera + 1')).toBe('formula.area + 1')
  })

  it('fixes a wrong namespace and a missing one', () => {
    expect(fix('feature.weight * 2')).toBe('lookup.weight * 2')
    expect(fix('2 * boom_reach')).toBe('2 * feature.boom_reach')
    expect(fix('lookp.weight')).toBe('lookup.weight')
  })

  it('matches a friendly name typed as a key', () => {
    expect(fix('formula.panel_area')).toBe('formula.area')
  })

  it('returns the friendly name and key of the fix', () => {
    const error = failure('feature.boom_rech', { references: keys })
    expect(closeMatchForError(error, references)).toEqual({
      namespace: 'feature',
      key: 'boom_reach',
      label: 'Boom reach',
      from: 0,
      to: 17,
      insertText: 'feature.boom_reach',
    })
  })

  it('offers nothing when no reference is close or the error is not about a reference', () => {
    expect(fix('feature.completely_different')).toBeNull()
    expect(fix('feature.q')).toBeNull()
    expect(closeMatchForError(failure('2 +'), references)).toBeNull()
  })
})
