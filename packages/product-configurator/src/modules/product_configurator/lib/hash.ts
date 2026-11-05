import { createHash } from 'node:crypto'
import type { ConfigurationDefinition } from '../data/validators'
import type { ForcedChange, RuleIssue, StructureError } from './evaluator/types'
import type { Selections } from './values'

type CanonicalValue = string | number | boolean | null | undefined | readonly CanonicalValue[] | CanonicalObject
type CanonicalObject = { readonly [key: string]: CanonicalValue }

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('[internal] product_configurator: non-finite number in canonical JSON')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (isCanonicalArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

function isCanonicalArray(value: readonly CanonicalValue[] | CanonicalObject): value is readonly CanonicalValue[] {
  return Array.isArray(value)
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

export function hashDefinition(definition: ConfigurationDefinition): string {
  return sha256(canonicalJson(definition))
}

export type ConfigurationHashInput = {
  modelVersionId: string
  modelVersionHash: string
  selections: Selections
  calculated: Record<string, string>
  forced: ForcedChange[]
  errors: StructureError[]
  warnings: RuleIssue[]
  bom: { sku: string; quantity: string; unitPrice: string; total: string }[]
  currencyCode: string
  priceKindId: string
}

export function hashConfiguration(input: ConfigurationHashInput): string {
  return sha256(
    canonicalJson({
      modelVersionId: input.modelVersionId,
      modelVersionHash: input.modelVersionHash,
      selections: input.selections,
      calculated: input.calculated,
      forced: input.forced.map((change) => ({
        featureKey: change.featureKey,
        ruleId: change.ruleId,
        from: change.from,
        to: change.to,
      })),
      errors: input.errors.map((issue) =>
        'ruleId' in issue ? { ruleId: issue.ruleId, params: issue.params } : { code: issue.code, params: issue.params },
      ),
      warnings: input.warnings.map((issue) => ({ ruleId: issue.ruleId, params: issue.params })),
      bom: input.bom.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.total,
      })),
      currencyCode: input.currencyCode,
      priceKindId: input.priceKindId,
    }),
  )
}
