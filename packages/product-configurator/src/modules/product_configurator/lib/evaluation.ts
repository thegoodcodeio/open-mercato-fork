import { defaultLocale } from '@open-mercato/shared/lib/i18n/config'
import type { ConfigurationDefinition, RawSelections } from '../data/validators'
import { evaluatePrice, totalQuantitiesBySku } from './evaluator/price'
import { evaluateStructure } from './evaluator/structure'
import type { PricedBomLine, StructureResult } from './evaluator/types'
import { currencyExponent } from './money'
import { resolveUnitPrices, type PriceContextRecord, type PricingInput } from './pricing'
import { buildSummary } from './summary'

export type ConfigurationBomLine = PricedBomLine & { label: string }

/**
 * A priced evaluation of one configuration: the settled structure, the BOM priced from the catalog,
 * the net price rounded to the currency, the configuration hash, the line summary and the pricing
 * context used. Stored as the session `evaluation`, returned by evaluate, and re-computed by finalise.
 */
export type ConfigurationResult = Omit<StructureResult, 'bom'> & {
  currencyExponent: number
  bom: ConfigurationBomLine[]
  netPrice: string
  hash: string
  summary: string
  priceContext: PriceContextRecord
  evaluatedAt: string
}

export type EvaluateConfigurationInput = {
  definition: ConfigurationDefinition
  modelVersion: { id: string; hash: string }
  selections: RawSelections | null | undefined
  pricing: Omit<PricingInput, 'currencyCode' | 'priceKindId' | 'allowPromotions'>
}

/**
 * Runs the structure step, prices the BOM through catalog (`lib/pricing.ts`) and the price step.
 * Throws `ConfiguratorEvaluationError` (`invalid_selection`, `fixed_point_not_reached`,
 * `forced_value_invalid`, `expression_error`, `price_missing`); blocking rule and system errors
 * (`option_not_available`, `bom_sku_unmapped`, ...) are part of the result with `finalisable: false`.
 */
export async function evaluateConfiguration(input: EvaluateConfigurationInput): Promise<ConfigurationResult> {
  const { definition } = input
  const structure = evaluateStructure({
    definition,
    modelVersionId: input.modelVersion.id,
    modelVersionHash: input.modelVersion.hash,
    selections: input.selections,
  })
  const prices = await resolveUnitPrices(
    {
      ...input.pricing,
      currencyCode: definition.commercial.currencyCode,
      priceKindId: definition.commercial.priceKindId,
      allowPromotions: definition.commercial.allowPromotions,
    },
    totalQuantitiesBySku(structure.bom),
  )
  const exponent = currencyExponent(definition.commercial.currencyCode)
  const priced = evaluatePrice({ structure, unitPrices: prices.unitPrices, currencyExponent: exponent })
  return {
    ...structure,
    currencyExponent: exponent,
    bom: priced.bom.map((line) => ({ ...line, label: prices.labels[line.sku] ?? line.sku })),
    netPrice: priced.netPrice,
    hash: priced.hash,
    summary: buildSummary({ definition, selections: structure.selections, visibility: structure.visibility, locale: defaultLocale }),
    priceContext: prices.priceContext,
    evaluatedAt: input.pricing.at.toISOString(),
  }
}
