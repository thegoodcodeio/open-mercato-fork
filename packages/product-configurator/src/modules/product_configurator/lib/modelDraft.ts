import { createHash } from 'node:crypto'
import { DEFINITION_LIMITS, definitionSchema, jsonNestingDepth, type ConfigurationDefinitionInput } from '../data/validators'
import { hashDefinition } from './hash'

export type DraftDefinition = Record<string, unknown>

export type DraftProblem = 'too_large' | 'too_deep' | 'currency_code_mismatch'

export function buildEmptyDefinition(commercial: { currencyCode: string; priceKindId: string }): ConfigurationDefinitionInput {
  return {
    schemaVersion: 1,
    commercial: { currencyCode: commercial.currencyCode, priceKindId: commercial.priceKindId, allowPromotions: false },
    fixedSpecification: [],
    features: [],
    rules: [],
    formulas: [],
    lookups: [],
    bom: [],
  }
}

function readCommercialCurrency(draft: DraftDefinition): unknown {
  const commercial = draft.commercial
  if (!commercial || typeof commercial !== 'object' || Array.isArray(commercial)) return undefined
  return (commercial as Record<string, unknown>).currencyCode
}

/**
 * A draft is work in progress: the full schema and the publication checks run on validate and
 * publish, so a draft that breaks them can still be saved. Only what would make the stored row
 * unusable is rejected here: size, nesting, and a currency that differs from the model's column.
 */
export function findDraftProblem(draft: DraftDefinition, modelCurrencyCode: string): DraftProblem | null {
  if (jsonNestingDepth(draft) > DEFINITION_LIMITS.jsonNestingDepth) return 'too_deep'
  if (new TextEncoder().encode(JSON.stringify(draft)).length > DEFINITION_LIMITS.definitionBytes) return 'too_large'
  if (readCommercialCurrency(draft) !== modelCurrencyCode) return 'currency_code_mismatch'
  return null
}

/**
 * Equals the published version hash when the draft is schema-valid and unchanged since publish, so
 * "unpublished changes" is a plain comparison. An invalid draft can never equal a version hash.
 */
export function computeDraftHash(draft: DraftDefinition): string {
  const parsed = definitionSchema.safeParse(draft)
  if (parsed.success) return hashDefinition(parsed.data)
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex')
}
