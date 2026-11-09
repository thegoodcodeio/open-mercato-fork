import type { ConfigurationSnapshot } from '../data/entities'
import type { ConfigurationDefinition, SelectionValue } from '../data/validators'
import { renderMessage } from './messages'
import { readConfigurationMarker, type StoredLine } from './quoteAccess'
import { sortByOrder } from './values'

export type SnapshotLineState = 'present' | 'removed'

/** `decimals`: the fraction digits a labelled formula is shown with, when it sets them. */
export type SnapshotRow = { label: string; value: string | number | boolean; unit: string | null; decimals?: number }

export type SnapshotReadModel = {
  id: string
  sessionId: string
  quoteId: string
  quoteLineId: string | null
  lineState: SnapshotLineState
  lineId: string | null
  lineName: string | null
  modelTitle: string | null
  modelVersion: { id: string; version: number | null; hash: string }
  summary: string
  selectionRows: SnapshotRow[]
  calculatedRows: SnapshotRow[]
  specification: Array<{ label: string; value: string }>
  bom: Array<{ sku: string; label: string; quantity: string; uom: string; unitPrice: string; total: string }>
  netPrice: string
  currencyCode: string
  warnings: Array<{ ruleId: string; label: string | null; message: string }>
  hash: string
  createdAt: string
}

export type SnapshotLineFacts = { state: SnapshotLineState; id: string | null; name: string | null }

export const REMOVED_LINE: SnapshotLineFacts = { state: 'removed', id: null, name: null }

export function presentLine(line: StoredLine): SnapshotLineFacts {
  return { state: 'present', id: line.id, name: line.name }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

function isSelectionValue(value: unknown): value is SelectionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Visible features in order, with the option label for choices and colors. */
function selectionRows(definition: ConfigurationDefinition | null, selections: Record<string, unknown>): SnapshotRow[] {
  if (!definition) return []
  const settled = readRecord(selections.settled)
  const visibility = readRecord(selections.visibility)
  return sortByOrder(definition.features).flatMap((feature) => {
    const value = settled[feature.key]
    if (visibility[feature.key] !== true || !isSelectionValue(value)) return []
    const display = feature.options?.find((option) => option.value === String(value))?.label ?? value
    return [{ label: feature.label, value: display, unit: feature.unit ?? null }]
  })
}

/** Formulas with a label; unlabelled formulas are internal steps. */
function calculatedRows(definition: ConfigurationDefinition | null, calculated: Record<string, unknown>): SnapshotRow[] {
  if (!definition) return []
  return definition.formulas.flatMap((formula) => {
    const value = calculated[formula.key]
    if (!formula.label || typeof value !== 'number') return []
    const row: SnapshotRow = { label: formula.label, value, unit: formula.unit ?? null }
    return [formula.decimals === undefined ? row : { ...row, decimals: formula.decimals }]
  })
}

function bomRows(bom: Array<Record<string, unknown>>): SnapshotReadModel['bom'] {
  return bom.map((line) => ({
    sku: readString(line.sku),
    label: readString(line.label) || readString(line.sku),
    quantity: readString(line.quantity),
    uom: readString(line.uom),
    unitPrice: readString(line.unitPrice),
    total: readString(line.total),
  }))
}

function warningRows(
  definition: ConfigurationDefinition | null,
  warnings: Array<Record<string, unknown>>,
  storedBom: Array<Record<string, unknown>>,
  locale: string,
): SnapshotReadModel['warnings'] {
  const pricedBom = storedBom.map((line) => ({ bomId: readString(line.bomId), total: readString(line.total) }))
  return warnings.map((warning) => {
    const ruleId = readString(warning.ruleId)
    const rule = definition?.rules.find((entry) => entry.id === ruleId)
    if (!definition || !rule) return { ruleId, label: null, message: '' }
    const params = readRecord(warning.params) as Parameters<typeof renderMessage>[1]['params']
    return { ruleId, label: rule.label ?? null, message: renderMessage(rule.messageTemplate, { definition, params, locale, pricedBom }) }
  })
}

/**
 * Line facts per snapshot id from the lines of one document: the first line whose marker references
 * the snapshot is the one that carries it.
 */
export function linesBySnapshot(lines: StoredLine[]): Map<string, StoredLine> {
  const carried = new Map<string, StoredLine>()
  for (const line of lines) {
    const snapshotId = readConfigurationMarker(line.configuration)?.snapshotId
    if (snapshotId && !carried.has(snapshotId)) carried.set(snapshotId, line)
  }
  return carried
}

export function buildSnapshotReadModel(input: {
  snapshot: ConfigurationSnapshot
  definition: ConfigurationDefinition | null
  version: number | null
  modelTitle: string | null
  line: SnapshotLineFacts
  locale: string
}): SnapshotReadModel {
  const { snapshot, definition } = input
  return {
    id: snapshot.id,
    sessionId: snapshot.sessionId,
    quoteId: snapshot.quoteId,
    quoteLineId: snapshot.quoteLineId ?? null,
    lineState: input.line.state,
    lineId: input.line.id,
    lineName: input.line.name,
    modelTitle: input.modelTitle,
    modelVersion: { id: snapshot.modelVersionId, version: input.version, hash: snapshot.modelVersionHash },
    summary: snapshot.summary,
    selectionRows: selectionRows(definition, snapshot.selections),
    calculatedRows: calculatedRows(definition, snapshot.calculated),
    specification: definition?.fixedSpecification ?? [],
    bom: bomRows(snapshot.bom),
    netPrice: snapshot.netPrice,
    currencyCode: snapshot.currencyCode,
    warnings: warningRows(definition, snapshot.warnings, snapshot.bom, input.locale),
    hash: snapshot.hash,
    createdAt: snapshot.createdAt.toISOString(),
  }
}
