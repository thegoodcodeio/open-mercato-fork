import { hashConfiguration } from '../hash'
import {
  canonicalDecimal,
  formatScaled,
  PRICE_SCALE,
  QUANTITY_SCALE,
  rescale,
  toScaled,
  toScaledExact,
} from '../money'
import { ConfiguratorEvaluationError } from './errors'
import type { PricedBomLine, PriceResult, SkuQuantity, StructureBomLine, StructureResult } from './types'

export type PriceInput = {
  structure: StructureResult
  unitPrices: Readonly<Record<string, string>>
  currencyExponent: number
}

export function totalQuantitiesBySku(bom: readonly StructureBomLine[]): SkuQuantity[] {
  const totals = new Map<string, bigint>()
  for (const line of bom) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0n) + toScaledExact(line.quantity, QUANTITY_SCALE))
  }
  return [...totals].map(([sku, quantity]) => ({ sku, quantity: canonicalDecimal(quantity, QUANTITY_SCALE) }))
}

export function evaluatePrice(input: PriceInput): PriceResult {
  const { structure, unitPrices, currencyExponent } = input
  const lineScale = PRICE_SCALE + QUANTITY_SCALE
  let netPrice = 0n
  const bom: PricedBomLine[] = []
  const hashedBom: { sku: string; quantity: string; unitPrice: string; total: string }[] = []

  const missing = new Set<string>()

  for (const line of structure.bom) {
    const rawUnitPrice = Object.hasOwn(unitPrices, line.sku) ? unitPrices[line.sku] : undefined
    if (rawUnitPrice === undefined) {
      missing.add(line.sku)
      continue
    }
    const unitPrice = toScaledExact(rawUnitPrice, PRICE_SCALE)
    const quantity = toScaledExact(line.quantity, QUANTITY_SCALE)
    const total = rescale(unitPrice * quantity, lineScale, currencyExponent)
    netPrice += total
    bom.push({
      ...line,
      unitPrice: canonicalDecimal(unitPrice, PRICE_SCALE),
      total: formatScaled(total, currencyExponent),
    })
    hashedBom.push({
      sku: line.sku,
      quantity: quantity.toString(),
      unitPrice: unitPrice.toString(),
      total: total.toString(),
    })
  }

  if (missing.size > 0) throw new ConfiguratorEvaluationError('price_missing', { skus: [...missing] })

  const scaledCalculated: Record<string, string> = {}
  for (const [key, value] of Object.entries(structure.calculated)) {
    scaledCalculated[key] = toScaled(value, QUANTITY_SCALE).toString()
  }

  return {
    currencyCode: structure.currencyCode,
    currencyExponent,
    bom,
    skuQuantities: totalQuantitiesBySku(structure.bom),
    netPrice: formatScaled(netPrice, currencyExponent),
    hash: hashConfiguration({
      modelVersionId: structure.modelVersionId,
      modelVersionHash: structure.modelVersionHash,
      selections: structure.selections,
      calculated: scaledCalculated,
      forced: structure.forced,
      errors: structure.errors,
      warnings: structure.warnings,
      bom: hashedBom,
      currencyCode: structure.currencyCode,
      priceKindId: structure.priceKindId,
    }),
  }
}
