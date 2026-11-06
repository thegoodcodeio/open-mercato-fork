import type { EntityManager } from '@mikro-orm/postgresql'
import type { PricingContext } from '@open-mercato/core/modules/catalog/lib/pricing'
import type {
  CatalogItemRef,
  CatalogPriceRowService,
  CatalogScope,
} from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { CatalogPricingService } from '@open-mercato/core/modules/catalog/services/catalogPricingService'
import type { CustomerGroupsService } from '@open-mercato/core/modules/customer_groups/services/customerGroupsService'
import { ConfiguratorEvaluationError } from './evaluator/errors'
import type { SkuQuantity } from './evaluator/types'
import { tryResolve, type ServiceResolver } from './quoteAccess'

/** Who and when a configuration is priced for: the quote's channel and customer at the evaluation time. */
export type PricingParty = {
  channelId: string | null
  customerId: string | null
  at: Date
}

export type PricingInput = PricingParty & {
  em: EntityManager
  container: ServiceResolver
  scope: CatalogScope
  currencyCode: string
  priceKindId: string
  allowPromotions: boolean
}

/** The pricing context used, kept with a result (and later the snapshot) so a group-dependent price can be explained. */
export type PriceContextRecord = {
  currencyCode: string
  priceKindId: string
  allowPromotions: boolean
  channelId: string | null
  customerId: string | null
  customerIds: string[]
  customerGroupIds: string[]
  date: string
}

export type CatalogUnitPrices = {
  unitPrices: Record<string, string>
  labels: Record<string, string>
  priceContext: PriceContextRecord
}

/**
 * Groups of the customer at `at`. Called whenever `customerGroupsService` is registered, also without
 * a customer: it then returns the tenant default group, so group price rows apply as they do
 * elsewhere. `customer_groups` is optional, so an unregistered service gives `[]`.
 */
export async function resolveCustomerGroupIds(
  container: ServiceResolver,
  input: { customerId: string | null; tenantId: string; at: Date },
): Promise<string[]> {
  const service = tryResolve<CustomerGroupsService>(container, 'customerGroupsService')
  if (!service) return []
  const resolution = await service.resolveGroups({
    customerId: input.customerId,
    customerIds: input.customerId ? [input.customerId] : [],
    tenantId: input.tenantId,
    at: input.at,
  })
  return resolution.groupIds
}

/** A row's `minQuantity` defaults to 1, so a total such as 0.5 m picks its tier as 1; line totals keep the real quantity. */
export function tierQuantity(totalQuantity: string): number {
  return Math.max(1, Number(totalQuantity))
}

function requireService<T>(container: ServiceResolver, name: string): T {
  const service = tryResolve<T>(container, name)
  if (!service) throw new Error(`[internal] product_configurator: ${name} is not registered`)
  return service
}

function priceMissing(skus: string[], channelId: string | null): ConfiguratorEvaluationError {
  return new ConfiguratorEvaluationError('price_missing', { skus, channelId })
}

/**
 * One unit price per SKU, read through catalog: `catalogPriceRowService` fetches candidate rows for
 * the quantity-independent context, `catalogPricingService.resolvePriceMany` selects one row per SKU
 * with the total SKU quantity. Promotions are excluded unless the model allows them. A SKU that is
 * unknown, ambiguous, has no matching row or a row without `unitPriceNet` fails with `price_missing`.
 */
export async function resolveUnitPrices(input: PricingInput, skuQuantities: readonly SkuQuantity[]): Promise<CatalogUnitPrices> {
  const customerIds = input.customerId ? [input.customerId] : []
  const customerGroupIds = await resolveCustomerGroupIds(input.container, {
    customerId: input.customerId,
    tenantId: input.scope.tenantId,
    at: input.at,
  })
  const priceContext: PriceContextRecord = {
    currencyCode: input.currencyCode,
    priceKindId: input.priceKindId,
    allowPromotions: input.allowPromotions,
    channelId: input.channelId,
    customerId: input.customerId,
    customerIds,
    customerGroupIds,
    date: input.at.toISOString(),
  }
  const unitPrices: Record<string, string> = {}
  const labels: Record<string, string> = {}
  if (!skuQuantities.length) return { unitPrices, labels, priceContext }

  const rowService = requireService<CatalogPriceRowService>(input.container, 'catalogPriceRowService')
  const pricingService = requireService<CatalogPricingService>(input.container, 'catalogPricingService')

  const skus = skuQuantities.map((entry) => entry.sku)
  const resolution = await rowService.resolveSkus(input.em, skus, input.scope)
  const items: CatalogItemRef[] = []
  const unresolved: string[] = []
  for (const sku of skus) {
    const item = resolution.items.get(sku)
    if (item) items.push(item)
    else unresolved.push(sku)
  }
  if (unresolved.length) throw priceMissing(unresolved, input.channelId)

  const baseContext: PricingContext = {
    currencyCode: input.currencyCode,
    priceKindId: input.priceKindId,
    channelId: input.channelId,
    customerId: input.customerId,
    customerIds,
    customerGroupIds,
    quantity: 1,
    date: input.at,
  }
  const rows = await rowService.findPriceRows(input.em, items, baseContext, input.scope, {
    excludePromotions: !input.allowPromotions,
  })
  const selected = await pricingService.resolvePriceMany(
    skuQuantities.map((entry) => ({
      rows: rows.get(entry.sku) ?? [],
      context: { ...baseContext, quantity: tierQuantity(entry.quantity) },
    })),
  )

  const missing: string[] = []
  skuQuantities.forEach((entry, index) => {
    const unitPriceNet = selected[index]?.unitPriceNet
    if (unitPriceNet === null || unitPriceNet === undefined) {
      missing.push(entry.sku)
      return
    }
    unitPrices[entry.sku] = String(unitPriceNet)
    labels[entry.sku] = resolution.items.get(entry.sku)?.title ?? entry.sku
  })
  if (missing.length) throw priceMissing(missing, input.channelId)
  return { unitPrices, labels, priceContext }
}
