import type { BomLineDefinition, Condition } from '../../../../data/validators'
import { bomLineSchema } from '../../../../data/validators'
import { toFiniteNumber } from '../../../../lib/values'
import type { StudioDefinition } from '../types'

export type BomPartKind = 'sku' | 'lookup'
export type BomQuantityKind = 'number' | 'formula'

export type BomFormValues = {
  id: string
  partKind: BomPartKind
  sku: string
  lookupKey: string
  quantityKind: BomQuantityKind
  quantity: string
  formulaKey: string
  when: Condition[]
  /** Bound surcharge rule id; empty when none. */
  ruleId: string
  order: string
}

/** Field id -> i18n key of the message. */
export type BomFormErrors = Record<string, string>

export type BomFormResult = { ok: true; line: BomLineDefinition } | { ok: false; errors: BomFormErrors }

const ERROR_PREFIX = 'product_configurator.studio.bom.errors.'

export const BOM_ERROR_KEYS = {
  required: `${ERROR_PREFIX}required`,
  invalidId: `${ERROR_PREFIX}invalidId`,
  duplicateId: `${ERROR_PREFIX}duplicateId`,
  quantity: `${ERROR_PREFIX}quantity`,
  integer: `${ERROR_PREFIX}integer`,
  lookupMissing: `${ERROR_PREFIX}lookupMissing`,
  unitMissing: `${ERROR_PREFIX}unitMissing`,
  invalid: `${ERROR_PREFIX}invalid`,
} as const

export function nextBomOrder(lines: readonly BomLineDefinition[]): number {
  return lines.reduce((highest, line) => Math.max(highest, line.order), 0) + 10
}

/** `line_1`, `line_2`, ... : the first id not used by another line. */
export function suggestBomId(lines: readonly BomLineDefinition[]): string {
  const used = new Set(lines.map((line) => line.id))
  let index = lines.length + 1
  while (used.has(`line_${index}`)) index += 1
  return `line_${index}`
}

export function lineToForm(line: BomLineDefinition | undefined, defaults: { id: string; order: number }): BomFormValues {
  if (!line) {
    return {
      id: defaults.id,
      partKind: 'sku',
      sku: '',
      lookupKey: '',
      quantityKind: 'number',
      quantity: '1',
      formulaKey: '',
      when: [],
      ruleId: '',
      order: String(defaults.order),
    }
  }
  return {
    id: line.id,
    partKind: line.skuFromLookup ? 'lookup' : 'sku',
    sku: line.sku ?? '',
    lookupKey: line.skuFromLookup?.lookupKey ?? '',
    quantityKind: typeof line.quantity === 'number' ? 'number' : 'formula',
    quantity: typeof line.quantity === 'number' ? String(line.quantity) : '1',
    formulaKey: typeof line.quantity === 'number' ? '' : line.quantity.formulaKey,
    when: line.when,
    ruleId: line.ruleId ?? '',
    order: String(line.order),
  }
}

/** Value lookups whose values are read as SKUs; permitted lookups give option values, not parts. */
export function skuLookups(definition: StudioDefinition) {
  return definition.lookups.flatMap((lookup) => (lookup.kind === 'value' ? [lookup] : []))
}

/** Distinct SKUs a line can resolve to: its fixed SKU, or every value of its lookup. */
export function lineSkus(line: Pick<BomFormValues, 'partKind' | 'sku' | 'lookupKey'>, definition: StudioDefinition): string[] {
  if (line.partKind === 'sku') {
    const sku = line.sku.trim()
    return sku ? [sku] : []
  }
  const lookup = skuLookups(definition).find((entry) => entry.key === line.lookupKey)
  if (!lookup) return []
  return Array.from(new Set(lookup.rows.map((row) => String(row.value).trim()).filter((sku) => sku.length > 0)))
}

export function definitionLineSkus(line: BomLineDefinition, definition: StudioDefinition): string[] {
  return lineSkus(
    { partKind: line.skuFromLookup ? 'lookup' : 'sku', sku: line.sku ?? '', lookupKey: line.skuFromLookup?.lookupKey ?? '' },
    definition,
  )
}

/** True when the edited line still points at the same part as the saved one (then its stored unit may be kept). */
export function samePart(values: Pick<BomFormValues, 'partKind' | 'sku' | 'lookupKey'>, line: BomLineDefinition | undefined): boolean {
  if (!line) return false
  if (values.partKind === 'sku') return line.sku !== undefined && line.sku === values.sku.trim()
  return line.skuFromLookup?.lookupKey === values.lookupKey
}

function parseQuantity(raw: string): number | null {
  const parsed = toFiniteNumber(raw)
  return parsed !== null && parsed >= 0 ? parsed : null
}

/**
 * Builds a schema-valid BOM line from the row editor. `uom` is never typed: the editor passes the
 * catalog unit (or the stored one for an unchanged part when the catalog cannot give one).
 */
export function formToLine(
  values: BomFormValues,
  context: { otherIds: readonly string[]; definition: StudioDefinition; uom: string | null },
): BomFormResult {
  const errors: BomFormErrors = {}
  const id = values.id.trim()
  if (!id) errors.id = BOM_ERROR_KEYS.required
  else if (!bomLineSchema.shape.id.safeParse(id).success) errors.id = BOM_ERROR_KEYS.invalidId
  else if (context.otherIds.includes(id)) errors.id = BOM_ERROR_KEYS.duplicateId

  const sku = values.sku.trim()
  const lookup = skuLookups(context.definition).find((entry) => entry.key === values.lookupKey)
  if (values.partKind === 'sku' && !sku) errors.sku = BOM_ERROR_KEYS.required
  if (values.partKind === 'lookup' && !values.lookupKey) errors.lookupKey = BOM_ERROR_KEYS.required
  else if (values.partKind === 'lookup' && !lookup) errors.lookupKey = BOM_ERROR_KEYS.lookupMissing

  const quantity = values.quantityKind === 'number' ? parseQuantity(values.quantity) : null
  if (values.quantityKind === 'number' && quantity === null) errors.quantity = BOM_ERROR_KEYS.quantity
  if (values.quantityKind === 'formula' && !values.formulaKey) errors.formulaKey = BOM_ERROR_KEYS.required

  const order = toFiniteNumber(values.order)
  if (order === null || !Number.isInteger(order)) errors.order = BOM_ERROR_KEYS.integer
  if (!context.uom && !errors.sku && !errors.lookupKey) errors.unit = BOM_ERROR_KEYS.unitMissing
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const candidate = {
    id,
    ...(values.partKind === 'sku' ? { sku } : {}),
    ...(values.partKind === 'lookup' && lookup ? { skuFromLookup: { lookupKey: lookup.key, keyedBy: lookup.keyedBy } } : {}),
    uom: context.uom,
    quantity: values.quantityKind === 'number' ? quantity : { formulaKey: values.formulaKey },
    when: values.when,
    ...(values.ruleId ? { ruleId: values.ruleId } : {}),
    order,
  }
  const parsed = bomLineSchema.safeParse(candidate)
  if (parsed.success) return { ok: true, line: parsed.data }
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'line')
    if (!errors[field]) errors[field] = BOM_ERROR_KEYS.invalid
  }
  return { ok: false, errors }
}
