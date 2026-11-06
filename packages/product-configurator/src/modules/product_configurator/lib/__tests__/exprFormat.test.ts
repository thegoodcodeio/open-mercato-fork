import { DEFINITION_LIMITS, expressionSchema, expressionDepth, type Expression } from '../../data/validators'
import { formatExpression } from '../exprFormat'
import { parseExpression } from '../exprParse'

const feature = (featureKey: string): Expression => ({ kind: 'feature', featureKey })
const constant = (value: number): Expression => ({ kind: 'const', value })
const op = (operator: '+' | '-' | '*' | '/', left: Expression, right: Expression): Expression => ({
  kind: 'op',
  op: operator,
  left,
  right,
})

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const SAMPLE_CONSTANTS = [0, -0, 1, -1, 2.5, -0.125, 1e21, 1e-7, -3.4e-9, 123456.789, Number.MAX_SAFE_INTEGER, 0.1 + 0.2]
const SAMPLE_KEYS = ['a', 'boom_reach', '_x1', 'Weight', 'k'.repeat(64)]
const OPERATORS = ['+', '-', '*', '/'] as const

function generate(random: () => number, maxHeight: number): Expression {
  const pick = <Item>(items: readonly Item[]): Item => items[Math.floor(random() * items.length)]
  if (maxHeight <= 1 || random() < 0.3) {
    switch (pick(['const', 'feature', 'formula', 'lookup'] as const)) {
      case 'const':
        return constant(random() < 0.5 ? pick(SAMPLE_CONSTANTS) : Math.round((random() - 0.5) * 1e6) / 1e3)
      case 'feature':
        return { kind: 'feature', featureKey: pick(SAMPLE_KEYS) }
      case 'formula':
        return { kind: 'formula', formulaKey: pick(SAMPLE_KEYS) }
      case 'lookup':
        return { kind: 'lookup', lookupKey: pick(SAMPLE_KEYS) }
    }
  }
  return op(pick(OPERATORS), generate(random, maxHeight - 1), generate(random, maxHeight - 1))
}

describe('formatExpression', () => {
  it('prints references, numbers and single spaces around operators', () => {
    expect(formatExpression(op('/', op('*', feature('boom_reach'), { kind: 'lookup', lookupKey: 'weight' }), constant(2)))).toBe(
      'feature.boom_reach * lookup.weight / 2',
    )
    expect(formatExpression({ kind: 'formula', formulaKey: 'area' })).toBe('formula.area')
    expect(formatExpression(constant(-0.5))).toBe('-0.5')
    expect(formatExpression(constant(-0))).toBe('-0')
    expect(formatExpression(constant(1e21))).toBe('1e+21')
  })

  it('uses only the parentheses the tree needs', () => {
    const [a, b, c] = [feature('a'), feature('b'), feature('c')]
    expect(formatExpression(op('+', op('+', a, b), c))).toBe('feature.a + feature.b + feature.c')
    expect(formatExpression(op('+', a, op('+', b, c)))).toBe('feature.a + (feature.b + feature.c)')
    expect(formatExpression(op('-', a, op('-', b, c)))).toBe('feature.a - (feature.b - feature.c)')
    expect(formatExpression(op('*', op('+', a, b), c))).toBe('(feature.a + feature.b) * feature.c')
    expect(formatExpression(op('+', op('*', a, b), c))).toBe('feature.a * feature.b + feature.c')
    expect(formatExpression(op('+', a, op('*', b, c)))).toBe('feature.a + feature.b * feature.c')
    expect(formatExpression(op('/', a, op('*', b, c)))).toBe('feature.a / (feature.b * feature.c)')
    expect(formatExpression(op('-', a, constant(-2)))).toBe('feature.a - -2')
  })

  it('round-trips many generated trees and prints canonical text', () => {
    const random = seededRandom(20261105)
    for (let sample = 0; sample < 2000; sample += 1) {
      const expression = generate(random, 1 + Math.floor(random() * DEFINITION_LIMITS.expressionDepth))
      const text = formatExpression(expression)
      const parsed = parseExpression(text)
      if (!parsed.ok) throw new Error(`[internal] ${text}: ${parsed.error.code}`)
      expect(parsed.expression).toEqual(expression)
      expect(formatExpression(parsed.expression)).toBe(text)
      expect(expressionSchema.safeParse(parsed.expression).success).toBe(true)
    }
  })

  it('round-trips a tree at exactly the depth limit', () => {
    let left: Expression = feature('x')
    let right: Expression = feature('x')
    for (let level = 1; level < DEFINITION_LIMITS.expressionDepth; level += 1) {
      left = op('-', left, constant(level))
      right = op('-', constant(level), right)
    }
    for (const expression of [left, right]) {
      expect(expressionDepth(expression)).toBe(DEFINITION_LIMITS.expressionDepth)
      const parsed = parseExpression(formatExpression(expression))
      expect(parsed).toEqual({ ok: true, expression })
    }
  })
})
