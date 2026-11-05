import { indexDefinition } from '../evaluator/context'
import { checkCatalog, type PublicationCatalogPort } from './catalogChecks'
import {
  checkDefaults,
  checkDuplicateKeys,
  checkLookupCoverage,
  checkPlaceholders,
  checkReferentialIntegrity,
  checkSurchargeBindings,
} from './definitionChecks'
import { checkFixedPoint } from './fixedPoint'
import { checkFormulaCycles, checkNumericExpressionReferences } from './formulas'
import { parseDefinitionForPublication } from './schemaIssues'
import type { ValidationReport } from './types'

export type PublicationInput = {
  /** The stored draft as JSON; `schema` and `limits` run first and the other checks need it to pass. */
  definition: unknown
  productId: string
  catalog: PublicationCatalogPort
}

export async function validateForPublication(input: PublicationInput): Promise<ValidationReport> {
  const parsed = parseDefinitionForPublication(input.definition)
  if (!parsed.definition) return { ok: false, issues: parsed.issues }

  const index = indexDefinition(parsed.definition)
  const issues = [
    ...checkDuplicateKeys(index),
    ...checkReferentialIntegrity(index),
    ...checkLookupCoverage(index),
    ...checkFormulaCycles(parsed.definition),
    ...checkNumericExpressionReferences(index),
    ...checkDefaults(index),
    ...checkSurchargeBindings(index),
    ...checkPlaceholders(index),
    ...checkFixedPoint(index),
    ...(await checkCatalog({ definition: parsed.definition, productId: input.productId, catalog: input.catalog })),
  ]
  return { ok: issues.length === 0, issues }
}

export { createPublicationCatalogPort, type PublicationCatalogPort } from './catalogChecks'
export * from './types'
