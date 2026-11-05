import type { ConfigurationDefinition } from '../data/validators'
import { FORMULA_MAX_DECIMALS } from '../data/validators'
import type { IssueParams, IssueParamValue } from './evaluator/types'

const VALUE_PLACEHOLDER_KINDS = ['feature', 'formula', 'lookup'] as const
type ValuePlaceholderKind = (typeof VALUE_PLACEHOLDER_KINDS)[number]

export type Placeholder =
  | { kind: ValuePlaceholderKind; key: string; token: string }
  | { kind: 'line'; bomId: string; token: string }

const PLACEHOLDER_PATTERN = /\{(?:(feature|formula|lookup)\.([A-Za-z_][A-Za-z0-9_]*)|line\.([A-Za-z0-9_-]+)\.total)\}/g

function isValuePlaceholderKind(value: string | undefined): value is ValuePlaceholderKind {
  return VALUE_PLACEHOLDER_KINDS.some((kind) => kind === value)
}

function toPlaceholder(
  token: string,
  kind: string | undefined,
  key: string | undefined,
  bomId: string | undefined,
): Placeholder | null {
  if (bomId !== undefined) return { kind: 'line', bomId, token }
  if (isValuePlaceholderKind(kind) && key !== undefined) return { kind, key, token }
  return null
}

export function extractPlaceholders(template: string): Placeholder[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].flatMap(([token, kind, key, bomId]) => {
    const placeholder = toPlaceholder(token, kind, key, bomId)
    return placeholder ? [placeholder] : []
  })
}

export function placeholderParamKey(placeholder: Placeholder): string {
  return placeholder.kind === 'line' ? `line.${placeholder.bomId}.total` : `${placeholder.kind}.${placeholder.key}`
}

export type RenderMessageOptions = {
  definition: ConfigurationDefinition
  params: IssueParams
  locale: string
  pricedBom?: readonly { bomId: string; total: string }[]
}

export function renderMessage(template: string, options: RenderMessageOptions): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (token: string, kind: string | undefined, key: string | undefined, bomId: string | undefined) => {
      const placeholder = toPlaceholder(token, kind, key, bomId)
      return (placeholder && renderPlaceholder(placeholder, options)) ?? token
    },
  )
}

function renderPlaceholder(placeholder: Placeholder, options: RenderMessageOptions): string | null {
  const { definition, locale } = options
  if (placeholder.kind === 'line') {
    const line = options.pricedBom?.find((entry) => entry.bomId === placeholder.bomId)
    if (!line) return null
    return new Intl.NumberFormat(locale, { style: 'currency', currency: definition.commercial.currencyCode }).format(
      Number(line.total),
    )
  }
  const value = options.params[placeholderParamKey(placeholder)]
  if (value === undefined || value === null) return null
  if (placeholder.kind === 'feature') return renderFeatureValue(placeholder.key, value, options)
  if (placeholder.kind === 'formula') {
    if (typeof value !== 'number') return String(value)
    const decimals = definition.formulas.find((formula) => formula.key === placeholder.key)?.decimals
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals ?? 0,
      maximumFractionDigits: decimals ?? FORMULA_MAX_DECIMALS,
    }).format(value)
  }
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'number' ? formatNumber(value, locale) : String(value)
}

function renderFeatureValue(featureKey: string, value: IssueParamValue, options: RenderMessageOptions): string {
  const feature = options.definition.features.find((entry) => entry.key === featureKey)
  if (typeof value === 'number') return formatNumber(value, options.locale)
  const option = feature?.options?.find((entry) => entry.value === value)
  return option ? option.label : String(value)
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: FORMULA_MAX_DECIMALS }).format(value)
}
