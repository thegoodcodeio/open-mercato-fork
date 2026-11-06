import type { Expression } from '../data/validators'

export type ExpressionOperator = Extract<Expression, { kind: 'op' }>['op']
export type ExpressionNamespace = 'feature' | 'formula' | 'lookup'

export const EXPRESSION_NAMESPACES: readonly ExpressionNamespace[] = ['feature', 'formula', 'lookup']

export const OPERATOR_PRECEDENCE: Record<ExpressionOperator, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }

const LEAF_PRECEDENCE = 3

export function referenceText(namespace: ExpressionNamespace, key: string): string {
  return `${namespace}.${key}`
}

// `String(-0)` drops the sign, and the parser reads `-0` back as negative zero.
export function formatNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}

function precedence(expression: Expression): number {
  return expression.kind === 'op' ? OPERATOR_PRECEDENCE[expression.op] : LEAF_PRECEDENCE
}

/**
 * Canonical text: single spaces around binary operators and only the parentheses the AST needs.
 * The parser is left-associative, so a right operand of equal precedence keeps its parentheses
 * even for `+` and `*` (`a + (b + c)` is a different tree than `a + b + c`).
 */
export function formatExpression(expression: Expression): string {
  switch (expression.kind) {
    case 'const':
      return formatNumber(expression.value)
    case 'feature':
      return referenceText('feature', expression.featureKey)
    case 'formula':
      return referenceText('formula', expression.formulaKey)
    case 'lookup':
      return referenceText('lookup', expression.lookupKey)
    case 'op': {
      const parent = OPERATOR_PRECEDENCE[expression.op]
      const left = formatExpression(expression.left)
      const right = formatExpression(expression.right)
      const leftText = precedence(expression.left) < parent ? `(${left})` : left
      const rightText = precedence(expression.right) <= parent ? `(${right})` : right
      return `${leftText} ${expression.op} ${rightText}`
    }
  }
}
