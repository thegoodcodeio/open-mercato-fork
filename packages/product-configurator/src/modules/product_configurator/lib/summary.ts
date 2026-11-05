import type { ConfigurationDefinition, Feature, SelectionValue } from '../data/validators'
import { FORMULA_MAX_DECIMALS } from '../data/validators'
import { sortByOrder, type Selections } from './values'

export const SUMMARY_MAX_LENGTH = 1000
const SUMMARY_SEPARATOR = '; '

export type SummaryInput = {
  definition: ConfigurationDefinition
  selections: Selections
  visibility: Record<string, boolean>
  locale: string
}

export function buildSummary(input: SummaryInput): string {
  const numberFormat = new Intl.NumberFormat(input.locale, { maximumFractionDigits: FORMULA_MAX_DECIMALS })
  let summary = ''
  for (const feature of sortByOrder(input.definition.features)) {
    if (!feature.inSummary || !input.visibility[feature.key]) continue
    const entry = summaryEntry(feature, input.selections[feature.key], numberFormat)
    if (entry === null) continue
    const next = summary ? `${summary}${SUMMARY_SEPARATOR}${entry}` : entry
    if (next.length > SUMMARY_MAX_LENGTH) break
    summary = next
  }
  return summary
}

function summaryEntry(
  feature: Feature,
  value: SelectionValue | undefined,
  numberFormat: Intl.NumberFormat,
): string | null {
  if (feature.type === 'boolean') return value === true ? feature.label : null
  if (value === undefined || value === '') return null
  const display =
    typeof value === 'number'
      ? numberFormat.format(value)
      : (feature.options?.find((option) => option.value === String(value))?.label ?? String(value))
  return `${feature.label}: ${display}${feature.unit ? ` ${feature.unit}` : ''}`
}
