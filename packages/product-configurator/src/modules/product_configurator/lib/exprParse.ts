import {
  DEFINITION_LIMITS,
  expressionSchema,
  type ConfigurationDefinition,
  type Expression,
} from '../data/validators'
import {
  EXPRESSION_NAMESPACES,
  OPERATOR_PRECEDENCE,
  referenceText,
  type ExpressionNamespace,
  type ExpressionOperator,
} from './exprFormat'
import { toFiniteNumber } from './values'

export const EXPRESSION_PARSE_ERROR_CODES = [
  'empty_expression',
  'unexpected_token',
  'unexpected_end',
  'unbalanced_paren',
  'invalid_number',
  'decimal_comma',
  'missing_namespace',
  'unknown_namespace',
  'invalid_key',
  'unknown_reference',
  'unary_minus_unsupported',
  'expression_too_deep',
] as const

export type ExpressionParseErrorCode = (typeof EXPRESSION_PARSE_ERROR_CODES)[number]

export type ExpressionParseError = {
  code: ExpressionParseErrorCode
  messageKey: string
  /** 0-based offset into the source text (UTF-16 code units, like `selectionStart`). */
  position: number
  length: number
  near: string
  params: Record<string, string | number>
}

export type ExpressionParseResult = { ok: true; expression: Expression } | { ok: false; error: ExpressionParseError }

export type ExpressionReferenceKeys = Record<ExpressionNamespace, ReadonlySet<string>>

export type ParseExpressionOptions = { references?: ExpressionReferenceKeys }

type ExpressionModel = Pick<ConfigurationDefinition, 'features' | 'formulas' | 'lookups'>

export type ExpressionReference = { namespace: ExpressionNamespace; key: string; label: string }

export type ExpressionEdit = { from: number; to: number; insertText: string }

export type ExpressionSuggestion = ExpressionReference & ExpressionEdit

type Span = { position: number; length: number }

type Token =
  | (Span & { type: 'number'; value: number })
  | (Span & { type: 'reference'; namespace: ExpressionNamespace; key: string })
  | (Span & { type: 'operator'; op: ExpressionOperator })
  | (Span & { type: 'lparen' | 'rparen' | 'end' })

type Parsed = { expression: Expression; height: number }

const WHITESPACE = /\s/
const DIGIT = /[0-9]/
const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/
const WORD_PART = /[A-Za-z0-9_.]/
const NUMBER_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/
const DEFAULT_SUGGESTION_LIMIT = 8

class ExpressionParseFailure extends Error {
  constructor(readonly detail: ExpressionParseError) {
    super(detail.code)
  }
}

function errorMessageKey(code: ExpressionParseErrorCode): string {
  return `product_configurator.expression.errors.${code}`
}

function isNamespace(value: string): value is ExpressionNamespace {
  return EXPRESSION_NAMESPACES.some((namespace) => namespace === value)
}

function isOperator(value: string): value is ExpressionOperator {
  return Object.hasOwn(OPERATOR_PRECEDENCE, value)
}

function isValidKey(key: string): boolean {
  return expressionSchema.safeParse({ kind: 'feature', featureKey: key }).success
}

function charAt(text: string, position: number): string {
  return text.charAt(position)
}

function scanWhile(text: string, start: number, pattern: RegExp): number {
  let end = start
  while (end < text.length && pattern.test(charAt(text, end))) end += 1
  return end
}

function fail(
  text: string,
  code: ExpressionParseErrorCode,
  span: Span,
  params: Record<string, string | number> = {},
): never {
  throw new ExpressionParseFailure({
    code,
    messageKey: errorMessageKey(code),
    position: span.position,
    length: span.length,
    near: text.slice(span.position, span.position + span.length),
    params,
  })
}

function lexNumber(text: string, position: number): Token {
  let end = position
  while (end < text.length) {
    const char = charAt(text, end)
    if ((char === 'e' || char === 'E') && /[+-]/.test(charAt(text, end + 1)) && DIGIT.test(charAt(text, end + 2))) {
      end += 2
      continue
    }
    if (!IDENT_PART.test(char) && char !== '.') break
    end += 1
  }
  const span = { position, length: end - position }
  const raw = text.slice(position, end)
  if (charAt(text, end) === ',' && DIGIT.test(charAt(text, end + 1))) {
    fail(text, 'decimal_comma', { position, length: scanWhile(text, end + 1, DIGIT) - position })
  }
  if (!NUMBER_PATTERN.test(raw)) fail(text, 'invalid_number', span)
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(text, 'invalid_number', span)
  return { type: 'number', value, ...span }
}

function lexReference(text: string, position: number): Token {
  const namespaceEnd = scanWhile(text, position, IDENT_PART)
  const namespace = text.slice(position, namespaceEnd)
  if (charAt(text, namespaceEnd) !== '.') {
    fail(text, 'missing_namespace', { position, length: namespaceEnd - position }, { key: namespace })
  }
  const keyEnd = scanWhile(text, namespaceEnd + 1, IDENT_PART)
  const key = text.slice(namespaceEnd + 1, keyEnd)
  const span = { position, length: keyEnd - position }
  if (!isNamespace(namespace)) fail(text, 'unknown_namespace', span, { namespace, key })
  if (!isValidKey(key)) fail(text, 'invalid_key', span, { namespace, key })
  return { type: 'reference', namespace, key, ...span }
}

function lex(text: string, offset: number): Token {
  const position = scanWhile(text, offset, WHITESPACE)
  if (position >= text.length) return { type: 'end', position: text.length, length: 0 }
  const char = charAt(text, position)
  if (char === '(') return { type: 'lparen', position, length: 1 }
  if (char === ')') return { type: 'rparen', position, length: 1 }
  if (isOperator(char)) return { type: 'operator', op: char, position, length: 1 }
  if (DIGIT.test(char) || (char === '.' && DIGIT.test(charAt(text, position + 1)))) return lexNumber(text, position)
  if (IDENT_START.test(char)) return lexReference(text, position)
  const codePoint = text.codePointAt(position) ?? 0
  return fail(text, 'unexpected_token', { position, length: String.fromCodePoint(codePoint).length })
}

function parseText(text: string, references: ExpressionReferenceKeys | undefined): Expression {
  const limit = DEFINITION_LIMITS.expressionDepth
  let token = lex(text, 0)
  let parenDepth = 0
  const peek = (): Token => token
  const advance = () => {
    token = lex(text, token.position + token.length)
  }

  const leaf = (expression: Expression): Parsed => ({ expression, height: 1 })

  const combine = (operator: Token & { type: 'operator' }, left: Parsed, right: Parsed): Parsed => {
    const height = 1 + Math.max(left.height, right.height)
    if (height > limit) fail(text, 'expression_too_deep', operator, { limit })
    return { expression: { kind: 'op', op: operator.op, left: left.expression, right: right.expression }, height }
  }

  const parseFactor = (): Parsed => {
    const current = peek()
    switch (current.type) {
      case 'number':
        advance()
        return leaf({ kind: 'const', value: current.value })
      case 'reference': {
        if (references && !references[current.namespace].has(current.key)) {
          fail(text, 'unknown_reference', current, { namespace: current.namespace, key: current.key })
        }
        advance()
        if (current.namespace === 'feature') return leaf({ kind: 'feature', featureKey: current.key })
        if (current.namespace === 'formula') return leaf({ kind: 'formula', formulaKey: current.key })
        return leaf({ kind: 'lookup', lookupKey: current.key })
      }
      case 'operator': {
        if (current.op !== '-') return fail(text, 'unexpected_token', current)
        advance()
        const operand = peek()
        if (operand.type !== 'number') return fail(text, 'unary_minus_unsupported', current)
        advance()
        return leaf({ kind: 'const', value: -operand.value })
      }
      case 'lparen': {
        parenDepth += 1
        if (parenDepth > limit) fail(text, 'expression_too_deep', current, { limit })
        advance()
        const inner = parseSum()
        const closing = peek()
        if (closing.type === 'end') fail(text, 'unbalanced_paren', current)
        if (closing.type !== 'rparen') fail(text, 'unexpected_token', closing)
        parenDepth -= 1
        advance()
        return inner
      }
      case 'rparen':
        return fail(text, parenDepth === 0 ? 'unbalanced_paren' : 'unexpected_token', current)
      case 'end':
        return fail(text, 'unexpected_end', current)
    }
  }

  const parseBinary = (operators: readonly ExpressionOperator[], parseOperand: () => Parsed): Parsed => {
    let left = parseOperand()
    for (let current = peek(); current.type === 'operator' && operators.includes(current.op); current = peek()) {
      advance()
      left = combine(current, left, parseOperand())
    }
    return left
  }

  const parseProduct = (): Parsed => parseBinary(['*', '/'], parseFactor)
  const parseSum = (): Parsed => parseBinary(['+', '-'], parseProduct)

  if (peek().type === 'end') fail(text, 'empty_expression', { position: 0, length: 0 })
  const root = parseSum()
  const trailing = peek()
  if (trailing.type === 'rparen') fail(text, 'unbalanced_paren', trailing)
  if (trailing.type !== 'end') fail(text, 'unexpected_token', trailing)
  return root.expression
}

/**
 * Parses the formula text syntax (`feature.boom_reach * lookup.weight / 2`) without `eval`.
 * The AST has no unary minus node, so `-` directly before a number reads as a negative constant
 * and `-` before anything else fails with `unary_minus_unsupported` (write `0 - x` or `-1 * x`).
 * Parenthesis nesting is capped at the expression depth limit, so recursion stays bounded.
 */
export function parseExpression(text: string, options: ParseExpressionOptions = {}): ExpressionParseResult {
  try {
    return { ok: true, expression: parseText(text, options.references) }
  } catch (error) {
    if (error instanceof ExpressionParseFailure) return { ok: false, error: error.detail }
    throw error
  }
}

export function expressionReferenceKeys(model: ExpressionModel): ExpressionReferenceKeys {
  return {
    feature: new Set(model.features.map((feature) => feature.key)),
    formula: new Set(model.formulas.map((formula) => formula.key)),
    lookup: new Set(model.lookups.map((lookup) => lookup.key)),
  }
}

function allNumeric(values: readonly (string | number)[]): boolean {
  return values.length > 0 && values.every((value) => toFiniteNumber(value) !== null)
}

/** References a formula can read: number features, choice/color features with numeric options, formulas, numeric value lookups. */
export function numericExpressionReferences(
  model: ExpressionModel,
  options: { excludeFormulaKey?: string } = {},
): ExpressionReference[] {
  const lookups = new Map(model.lookups.map((lookup) => [lookup.key, lookup]))
  const references: ExpressionReference[] = []
  for (const feature of model.features) {
    const permitted = feature.optionsFromLookup ? lookups.get(feature.optionsFromLookup) : undefined
    const domain = feature.options
      ? feature.options.map((option) => option.value)
      : permitted?.kind === 'permitted'
        ? permitted.rows.flatMap((row) => row.values)
        : []
    const numeric = feature.type === 'number' || ((feature.type === 'choice' || feature.type === 'color') && allNumeric(domain))
    if (numeric) references.push({ namespace: 'feature', key: feature.key, label: feature.label })
  }
  for (const formula of model.formulas) {
    if (formula.key === options.excludeFormulaKey) continue
    references.push({ namespace: 'formula', key: formula.key, label: formula.label ?? formula.key })
  }
  for (const lookup of model.lookups) {
    if (lookup.kind !== 'value' || !allNumeric(lookup.rows.map((row) => row.value))) continue
    references.push({ namespace: 'lookup', key: lookup.key, label: lookup.label ?? lookup.key })
  }
  return references
}

function matchScore(reference: ExpressionReference, term: string): number | null {
  if (!term) return 0
  const key = reference.key.toLowerCase()
  const label = reference.label.toLowerCase()
  if (key.startsWith(term)) return 0
  if (label.startsWith(term)) return 1
  if (label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(term))) return 2
  if (key.includes(term)) return 3
  if (label.includes(term)) return 4
  return null
}

function compareReferences(left: ExpressionReference, right: ExpressionReference): number {
  return left.label.localeCompare(right.label) || left.key.localeCompare(right.key)
}

/**
 * Autocomplete for the word around the cursor, matched by friendly name and key.
 * `feature.` / `formula.` / `lookup.` narrow to one kind; picking a suggestion replaces the whole word with the reference.
 */
export function suggestExpressionReferences(
  text: string,
  cursor: number,
  references: readonly ExpressionReference[],
  limit = DEFAULT_SUGGESTION_LIMIT,
): ExpressionSuggestion[] {
  const caret = Math.min(Math.max(cursor, 0), text.length)
  let from = caret
  while (from > 0 && WORD_PART.test(charAt(text, from - 1))) from -= 1
  const to = scanWhile(text, caret, WORD_PART)
  const word = text.slice(from, caret)
  if (!word || !IDENT_START.test(charAt(word, 0))) return []
  const dot = word.indexOf('.')
  const namespace = dot >= 0 ? word.slice(0, dot) : null
  if (namespace !== null && !isNamespace(namespace)) return []
  const term = (dot >= 0 ? word.slice(dot + 1) : word).toLowerCase()
  return references
    .filter((reference) => namespace === null || reference.namespace === namespace)
    .flatMap((reference) => {
      const score = matchScore(reference, term)
      return score === null ? [] : [{ reference, score }]
    })
    .sort((left, right) => left.score - right.score || compareReferences(left.reference, right.reference))
    .slice(0, limit)
    .map(({ reference }) => ({ ...reference, from, to, insertText: referenceText(reference.namespace, reference.key) }))
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions cost 1. */
function editDistance(left: string, right: string): number {
  const distances = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  )
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      let distance = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + cost,
      )
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        distance = Math.min(distance, distances[row - 2][column - 2] + 1)
      }
      distances[row][column] = distance
    }
  }
  return distances[left.length][right.length]
}

function labelAsKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * One-click fix for an unknown or namespace-less reference: the closest reference by edit distance
 * to its key or friendly name, preferring the namespace that was typed. Null when nothing is close.
 */
export function closeMatchForError(
  error: ExpressionParseError,
  references: readonly ExpressionReference[],
): ExpressionSuggestion | null {
  if (error.code !== 'unknown_reference' && error.code !== 'missing_namespace' && error.code !== 'unknown_namespace') {
    return null
  }
  const typed = String(error.params.key ?? '').toLowerCase()
  if (!typed) return null
  const namespace = error.code === 'unknown_reference' ? error.params.namespace : null
  const maxDistance = typed.length <= 3 ? 1 : Math.floor(typed.length / 3)
  const [best] = references
    .flatMap((reference) => {
      const distance = Math.min(
        editDistance(typed, reference.key.toLowerCase()),
        editDistance(typed, labelAsKey(reference.label)),
      )
      if (distance > maxDistance || distance >= typed.length) return []
      const otherNamespace = namespace !== null && reference.namespace !== namespace ? 1 : 0
      return [{ reference, score: distance + otherNamespace, otherNamespace }]
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.otherNamespace - right.otherNamespace ||
        compareReferences(left.reference, right.reference),
    )
  if (!best) return null
  const { reference } = best
  return {
    ...reference,
    from: error.position,
    to: error.position + error.length,
    insertText: referenceText(reference.namespace, reference.key),
  }
}

export function applyExpressionEdit(text: string, edit: ExpressionEdit): { text: string; cursor: number } {
  return {
    text: text.slice(0, edit.from) + edit.insertText + text.slice(edit.to),
    cursor: edit.from + edit.insertText.length,
  }
}
