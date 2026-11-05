import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CatalogPriceKind, CatalogProduct, CatalogProductPrice, CatalogProductVariant } from '../data/entities'
import { isPromotionPriceKind } from '../lib/omnibusPresentedEntry'
import {
  buildPriceRowFilter,
  filterRowsForVariant,
  resolvePriceVariantId,
  type PriceRow,
  type PricingContext,
} from '../lib/pricing'

const MAX_SKUS_PER_CALL = 500

export type CatalogScope = {
  tenantId: string
  organizationId: string
}

export type BoundProductRef = {
  productId: string
  sku: string | null
  title: string
  taxRateId: string | null
}

/**
 * A product or variant matched by SKU. `unit` is the product's base unit (`defaultUnit`), the unit
 * price tiers are expressed in; variants have no unit columns and carry their product's values.
 */
export type CatalogItemRef = {
  sku: string
  productId: string
  variantId: string | null
  title: string
  unit: string | null
  salesUnitQuantity: string
}

export type SkuResolution = { items: Map<string, CatalogItemRef>; ambiguous: string[] }

export type PriceKindRef = { id: string; code: string; currencyCode: string | null; isPromotion: boolean }

export interface CatalogPriceRowService {
  /** Live (not soft-deleted) products in scope, keyed by id. Missing ids are absent from the map. */
  resolveProducts(em: EntityManager, ids: string[], scope: CatalogScope): Promise<Map<string, BoundProductRef>>
  /**
   * Matches live products and variants by exact SKU, at most 500 distinct SKUs per call. A SKU
   * found on both a product and a variant is returned in `ambiguous`, not in `items`.
   */
  resolveSkus(em: EntityManager, skus: string[], scope: CatalogScope): Promise<SkuResolution>
  /** Active, live price kinds of the tenant that belong to the organization or to no organization. */
  resolvePriceKinds(em: EntityManager, ids: string[], scope: CatalogScope): Promise<Map<string, PriceKindRef>>
  /**
   * Candidate price rows per `CatalogItemRef.sku`, for `catalogPricingService.resolvePriceMany`.
   * A product item gets product-level rows only; a variant item gets its product's product-level
   * rows plus its own rows, never a sibling variant's.
   */
  findPriceRows(
    em: EntityManager,
    items: CatalogItemRef[],
    context: PricingContext,
    scope: CatalogScope,
    options?: { excludePromotions?: boolean },
  ): Promise<Map<string, PriceRow[]>>
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)))
}

function assertSkuLimit(count: number): void {
  if (count > MAX_SKUS_PER_CALL) {
    throw new Error(`[internal] catalogPriceRowService accepts at most ${MAX_SKUS_PER_CALL} SKUs per call`)
  }
}

function resolvePriceProductId(row: PriceRow): string | null {
  if (!row.product) return null
  return typeof row.product === 'string' ? row.product : row.product.id
}

function hasUsablePriceKind(row: PriceRow, excludePromotions: boolean): boolean {
  if (excludePromotions && isPromotionPriceKind(row)) return false
  if (!row.priceKind || typeof row.priceKind === 'string') return true
  return row.priceKind.isActive !== false && !row.priceKind.deletedAt
}

export class DefaultCatalogPriceRowService implements CatalogPriceRowService {
  async resolveProducts(
    em: EntityManager,
    ids: string[],
    scope: CatalogScope,
  ): Promise<Map<string, BoundProductRef>> {
    const result = new Map<string, BoundProductRef>()
    const uniqueIds = uniqueNonEmpty(ids)
    if (!uniqueIds.length) return result

    const products = await findWithDecryption(
      em,
      CatalogProduct,
      {
        id: { $in: uniqueIds },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      { fields: ['id', 'sku', 'title', 'taxRateId'] },
      scope,
    )
    for (const product of products) {
      result.set(product.id, {
        productId: product.id,
        sku: product.sku ?? null,
        title: product.title,
        taxRateId: product.taxRateId ?? null,
      })
    }
    return result
  }

  async resolveSkus(em: EntityManager, skus: string[], scope: CatalogScope): Promise<SkuResolution> {
    const items = new Map<string, CatalogItemRef>()
    const uniqueSkus = uniqueNonEmpty(skus)
    assertSkuLimit(uniqueSkus.length)
    if (!uniqueSkus.length) return { items, ambiguous: [] }

    const products = await findWithDecryption(
      em,
      CatalogProduct,
      {
        sku: { $in: uniqueSkus },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      { fields: ['id', 'sku', 'title', 'defaultUnit', 'defaultSalesUnitQuantity'] },
      scope,
    )
    const variants = await findWithDecryption(
      em,
      CatalogProductVariant,
      {
        sku: { $in: uniqueSkus },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
        product: { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      },
      { populate: ['product'] },
      scope,
    )

    const productSkus = new Set<string>()
    for (const product of products) {
      if (!product.sku) continue
      productSkus.add(product.sku)
      items.set(product.sku, {
        sku: product.sku,
        productId: product.id,
        variantId: null,
        title: product.title,
        unit: product.defaultUnit ?? null,
        salesUnitQuantity: product.defaultSalesUnitQuantity,
      })
    }

    const ambiguousSkus = new Set<string>()
    for (const variant of variants) {
      if (!variant.sku) continue
      if (productSkus.has(variant.sku)) {
        ambiguousSkus.add(variant.sku)
        items.delete(variant.sku)
        continue
      }
      items.set(variant.sku, {
        sku: variant.sku,
        productId: variant.product.id,
        variantId: variant.id,
        title: variant.name ?? variant.product.title,
        unit: variant.product.defaultUnit ?? null,
        salesUnitQuantity: variant.product.defaultSalesUnitQuantity,
      })
    }

    return { items, ambiguous: uniqueSkus.filter((sku) => ambiguousSkus.has(sku)) }
  }

  async resolvePriceKinds(
    em: EntityManager,
    ids: string[],
    scope: CatalogScope,
  ): Promise<Map<string, PriceKindRef>> {
    const result = new Map<string, PriceKindRef>()
    const uniqueIds = uniqueNonEmpty(ids)
    if (!uniqueIds.length) return result

    const priceKinds = await findWithDecryption(
      em,
      CatalogPriceKind,
      {
        id: { $in: uniqueIds },
        tenantId: scope.tenantId,
        $or: [{ organizationId: scope.organizationId }, { organizationId: null }],
        deletedAt: null,
        isActive: true,
      },
      undefined,
      scope,
    )
    for (const priceKind of priceKinds) {
      result.set(priceKind.id, {
        id: priceKind.id,
        code: priceKind.code,
        currencyCode: priceKind.currencyCode ?? null,
        isPromotion: priceKind.isPromotion,
      })
    }
    return result
  }

  async findPriceRows(
    em: EntityManager,
    items: CatalogItemRef[],
    context: PricingContext,
    scope: CatalogScope,
    options: { excludePromotions?: boolean } = {},
  ): Promise<Map<string, PriceRow[]>> {
    const result = new Map<string, PriceRow[]>()
    if (!items.length) return result
    assertSkuLimit(new Set(items.map((item) => item.sku)).size)

    const productIds = uniqueNonEmpty(items.map((item) => item.productId))
    const variantIds = uniqueNonEmpty(items.map((item) => item.variantId))
    const productLevelClause: FilterQuery<CatalogProductPrice> = { product: { $in: productIds }, variant: null }
    const targetClause: FilterQuery<CatalogProductPrice> = variantIds.length
      ? { $or: [productLevelClause, { variant: { $in: variantIds } }] }
      : productLevelClause
    const where: FilterQuery<CatalogProductPrice> = {
      $and: [buildPriceRowFilter(context), targetClause],
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
    const rows: PriceRow[] = await findWithDecryption(
      em,
      CatalogProductPrice,
      where,
      { populate: ['priceKind', 'offer'] },
      scope,
    )
    const excludePromotions = options.excludePromotions === true
    const usableRows = rows.filter((row) => hasUsablePriceKind(row, excludePromotions))

    for (const item of items) {
      const candidates = usableRows.filter(
        (row) =>
          resolvePriceProductId(row) === item.productId ||
          (item.variantId !== null && resolvePriceVariantId(row) === item.variantId),
      )
      result.set(item.sku, filterRowsForVariant(candidates, item.variantId))
    }
    return result
  }
}
