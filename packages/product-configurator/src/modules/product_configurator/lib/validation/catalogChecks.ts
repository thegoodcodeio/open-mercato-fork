import type { EntityManager } from '@mikro-orm/postgresql'
import type {
  BoundProductRef,
  CatalogItemRef,
  CatalogPriceRowService,
  CatalogScope,
  PriceKindRef,
  SkuResolution,
} from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { ConfigurationDefinition } from '../../data/validators'
import type { ValidationIssue, ValidationRef } from './types'

const SKUS_PER_CATALOG_CALL = 500

/** The catalog reads publication needs, bound to one EntityManager and scope so the checks stay unit-testable. */
export type PublicationCatalogPort = {
  resolveProducts(ids: string[]): Promise<Map<string, BoundProductRef>>
  resolveSkus(skus: string[]): Promise<SkuResolution>
  resolvePriceKinds(ids: string[]): Promise<Map<string, PriceKindRef>>
}

export function createPublicationCatalogPort(
  service: CatalogPriceRowService,
  em: EntityManager,
  scope: CatalogScope,
): PublicationCatalogPort {
  return {
    resolveProducts: (ids) => service.resolveProducts(em, ids, scope),
    resolveSkus: (skus) => service.resolveSkus(em, skus, scope),
    resolvePriceKinds: (ids) => service.resolvePriceKinds(em, ids, scope),
  }
}

export type CatalogCheckInput = {
  definition: ConfigurationDefinition
  productId: string
  catalog: PublicationCatalogPort
}

/** SKUs a BOM line can produce: its fixed SKU, or every value of its SKU lookup. */
function lineSkus(definition: ConfigurationDefinition): Map<string, string[]> {
  const lookups = new Map(definition.lookups.map((lookup) => [lookup.key, lookup]))
  const skus = new Map<string, string[]>()
  for (const line of definition.bom) {
    if (line.sku !== undefined) {
      skus.set(line.id, [line.sku])
      continue
    }
    const lookup = line.skuFromLookup ? lookups.get(line.skuFromLookup.lookupKey) : undefined
    const values = lookup?.kind === 'value' ? lookup.rows.map((row) => String(row.value)) : []
    skus.set(line.id, [...new Set(values)])
  }
  return skus
}

async function resolveAllSkus(catalog: PublicationCatalogPort, skus: string[]): Promise<SkuResolution> {
  const items = new Map<string, CatalogItemRef>()
  const ambiguous: string[] = []
  for (let start = 0; start < skus.length; start += SKUS_PER_CATALOG_CALL) {
    const resolution = await catalog.resolveSkus(skus.slice(start, start + SKUS_PER_CATALOG_CALL))
    resolution.items.forEach((item, sku) => items.set(sku, item))
    ambiguous.push(...resolution.ambiguous)
  }
  return { items, ambiguous }
}

/**
 * `referential_integrity` for the bound product and SKUs, `ambiguous_sku`, `bom_unit_mismatch` and
 * `price_kind`. Catalog calls run one after another because they share the caller's EntityManager.
 */
export async function checkCatalog(input: CatalogCheckInput): Promise<ValidationIssue[]> {
  const { definition, productId, catalog } = input
  const issues: ValidationIssue[] = []

  const products = await catalog.resolveProducts([productId])
  if (!products.has(productId)) {
    issues.push({
      check: 'referential_integrity',
      code: 'product_missing',
      params: { productId },
      refs: [{ kind: 'product', key: productId }],
    })
  }

  const skusByLine = lineSkus(definition)
  const usage = new Map<string, ValidationRef[]>()
  for (const line of definition.bom) {
    for (const sku of skusByLine.get(line.id) ?? []) {
      const refs = usage.get(sku) ?? []
      refs.push({ kind: 'bom', key: line.id })
      if (line.skuFromLookup) refs.push({ kind: 'lookup', key: line.skuFromLookup.lookupKey })
      usage.set(sku, refs)
    }
  }
  const resolution = await resolveAllSkus(catalog, [...usage.keys()])
  const ambiguous = new Set(resolution.ambiguous)
  for (const [sku, refs] of usage) {
    if (ambiguous.has(sku)) {
      issues.push({ check: 'ambiguous_sku', code: 'ambiguous_sku', params: { sku }, refs })
    } else if (!resolution.items.has(sku)) {
      issues.push({ check: 'referential_integrity', code: 'unknown_sku', params: { sku }, refs })
    }
  }

  for (const line of definition.bom) {
    for (const sku of skusByLine.get(line.id) ?? []) {
      const item = resolution.items.get(sku)
      if (!item) continue
      const refs: ValidationRef[] = [{ kind: 'bom', key: line.id }]
      if (item.unit === null) {
        issues.push({ check: 'bom_unit_mismatch', code: 'bom_unit_missing', params: { bomId: line.id, sku }, refs })
      } else if (item.unit !== line.uom) {
        issues.push({
          check: 'bom_unit_mismatch',
          code: 'bom_unit_mismatch',
          params: { bomId: line.id, sku, uom: line.uom, unit: item.unit },
          refs,
        })
      }
      if (Number(item.salesUnitQuantity) !== 1) {
        issues.push({
          check: 'bom_unit_mismatch',
          code: 'bom_sales_unit_quantity',
          params: { bomId: line.id, sku, salesUnitQuantity: item.salesUnitQuantity },
          refs,
        })
      }
    }
  }

  const priceKindId = definition.commercial.priceKindId
  const priceKinds = await catalog.resolvePriceKinds([priceKindId])
  if (!priceKinds.has(priceKindId)) {
    issues.push({
      check: 'price_kind',
      code: 'price_kind_missing',
      params: { priceKindId },
      refs: [{ kind: 'priceKind', key: priceKindId }],
    })
  }
  return issues
}
