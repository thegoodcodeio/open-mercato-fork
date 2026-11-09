import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { ExpressionParseError, ExpressionParseErrorCode } from '../../../../lib/exprParse'

const FALLBACKS: Record<ExpressionParseErrorCode, string> = {
  empty_expression: 'Enter an expression.',
  unexpected_token: 'This character or word does not fit here.',
  unexpected_end: 'The expression ends too early. Add a number or a reference.',
  unbalanced_paren: 'The parentheses do not match.',
  invalid_number: 'This is not a valid number.',
  decimal_comma: 'Use a dot for decimals, for example 1.5.',
  missing_namespace: '"{key}" needs a prefix: feature.{key}, formula.{key} or lookup.{key}.',
  unknown_namespace: 'Unknown prefix in {namespace}.{key}. Use feature., formula. or lookup.',
  invalid_key: 'The key in {namespace}.{key} is not valid. Use letters, digits and _ only, starting with a letter or _.',
  unknown_reference: 'No {namespace} named "{key}".',
  unary_minus_unsupported: 'A minus sign can only stand before a number. Write 0 - x or -1 * x.',
  expression_too_deep: 'The expression is nested too deeply (at most {limit} levels).',
}

export function expressionErrorMessage(error: ExpressionParseError, t: TranslateFn): string {
  return t(error.messageKey, FALLBACKS[error.code], error.params)
}
