import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CatalogItemRef, CatalogPriceRowService } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { getEntityIds } from '@open-mercato/shared/lib/encryption/entityIds'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ConfigurationModel } from '../data/entities'
import type { ModelCreateInput, ModelIdInput } from '../data/validators'
import {
  buildReferenceDefinition,
  REFERENCE_BOUND_PRODUCT,
  REFERENCE_MODEL_CURRENCY,
  REFERENCE_MODEL_KEY,
  REFERENCE_MODEL_TITLE,
  REFERENCE_PARTS,
  type ReferencePart,
} from './referenceModel'

const logger = createLogger('product_configurator.seeds')

export type ProductConfiguratorSeedScope = { tenantId: string; organizationId: string }

function buildSeedCommandContext(container: AwilixContainer, scope: ProductConfiguratorSeedScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    systemActor: true,
  }
}

type PriceKindRow = { id: string; organization_id: string | null }

/** Catalog price kinds are read through the query engine, not the catalog ORM entity; an empty organization id selects tenant-wide kinds. */
async function findRegularPriceKindId(container: AwilixContainer, scope: ProductConfiguratorSeedScope): Promise<string | null> {
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const { items } = await queryEngine.query<PriceKindRow>(getEntityIds().catalog.catalog_price_kind, {
    tenantId: scope.tenantId,
    organizationIds: [scope.organizationId, ''],
    filters: { code: { $eq: 'regular' }, is_active: { $eq: true } },
    fields: ['id', 'organization_id'],
    page: { page: 1, pageSize: 10 },
  })
  const own = items.find((row) => row.organization_id === scope.organizationId)
  return (own ?? items[0])?.id ?? null
}

async function findPartsWithoutPrice(
  em: EntityManager,
  catalogPriceRowService: CatalogPriceRowService,
  items: CatalogItemRef[],
  priceKindId: string,
  scope: ProductConfiguratorSeedScope,
): Promise<Set<string>> {
  if (items.length === 0) return new Set()
  const rows = await catalogPriceRowService.findPriceRows(
    em,
    items,
    { priceKindId, currencyCode: REFERENCE_MODEL_CURRENCY, quantity: 1, date: new Date() },
    scope,
    { excludePromotions: true },
  )
  return new Set(items.filter((item) => (rows.get(item.sku) ?? []).length === 0).map((item) => item.sku))
}

/**
 * Creates the reference telehandler model with its catalog products and prices through catalog commands,
 * then publishes version 1 through this module's commands. Safe to run again after a partial failure:
 * missing products and prices are created (a missing price of a reused variant goes on the variant),
 * an existing unpublished reference model is published, and nothing happens once the reference model
 * has a published version. An unpublished reference model bound to another product than the reference
 * SKU (for example after that product was deleted) is skipped with a warning, so `mercato init` never aborts.
 */
export async function seedReferenceModel(
  em: EntityManager,
  container: AwilixContainer,
  scope: ProductConfiguratorSeedScope,
): Promise<boolean> {
  const existing = await findOneWithDecryption(
    em,
    ConfigurationModel,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, modelKey: REFERENCE_MODEL_KEY, deletedAt: null },
    undefined,
    scope,
  )
  if (existing?.latestVersionId) return false

  const priceKindId = await findRegularPriceKindId(container, scope)
  if (!priceKindId) {
    logger.warn('Skipping the reference model: no active "regular" catalog price kind', { tenantId: scope.tenantId })
    return false
  }

  const commandBus = container.resolve<CommandBus>('commandBus')
  const catalogPriceRowService = container.resolve<CatalogPriceRowService>('catalogPriceRowService')
  const ctx = buildSeedCommandContext(container, scope)

  const createPrice = (target: Pick<CatalogItemRef, 'productId' | 'variantId'>, part: ReferencePart) =>
    commandBus.execute('catalog.prices.create', {
      input: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        productId: target.productId,
        ...(target.variantId ? { variantId: target.variantId } : {}),
        priceKindId,
        currencyCode: REFERENCE_MODEL_CURRENCY,
        unitPriceNet: part.unitPriceNet,
      },
      ctx,
    })

  const products = [{ ...REFERENCE_BOUND_PRODUCT, unitPriceNet: null }, ...REFERENCE_PARTS]
  const { items } = await catalogPriceRowService.resolveSkus(em, products.map((product) => product.sku), scope)
  if (existing && items.get(REFERENCE_BOUND_PRODUCT.sku)?.productId !== existing.productId) {
    logger.warn('Skipping the reference model: the unpublished reference model is bound to another product than the reference SKU', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      modelId: existing.id,
    })
    return false
  }
  const productIds = new Map([...items].map(([sku, item]) => [sku, item.productId]))
  const reusedParts = REFERENCE_PARTS.flatMap((part) => {
    const item = items.get(part.sku)
    return item ? [item] : []
  })
  const unpricedSkus = await findPartsWithoutPrice(em, catalogPriceRowService, reusedParts, priceKindId, scope)

  for (const product of products) {
    const reused = items.get(product.sku)
    if (reused) {
      if (product.unitPriceNet !== null && unpricedSkus.has(product.sku)) await createPrice(reused, product)
      continue
    }
    const { result } = await commandBus.execute<Record<string, unknown>, { productId: string }>('catalog.products.create', {
      input: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        title: product.title,
        sku: product.sku,
        description: `Example part of the ${REFERENCE_MODEL_TITLE} configuration model.`,
        productType: 'simple',
        defaultUnit: product.unit,
        primaryCurrencyCode: REFERENCE_MODEL_CURRENCY,
        isActive: true,
      },
      ctx,
    })
    productIds.set(product.sku, result.productId)
    if (product.unitPriceNet !== null) await createPrice({ productId: result.productId, variantId: null }, product)
  }

  const boundProductId = productIds.get(REFERENCE_BOUND_PRODUCT.sku)
  if (!boundProductId) throw new Error('[internal] product_configurator: reference product was not created')

  const modelId = existing
    ? existing.id
    : (
        await commandBus.execute<ModelCreateInput, { id: string }>('product_configurator.models.create', {
          input: {
            productId: boundProductId,
            modelKey: REFERENCE_MODEL_KEY,
            title: REFERENCE_MODEL_TITLE,
            currencyCode: REFERENCE_MODEL_CURRENCY,
            priceKindId,
            draftDefinition: buildReferenceDefinition({ currencyCode: REFERENCE_MODEL_CURRENCY, priceKindId }),
          },
          ctx,
        })
      ).result.id
  await commandBus.execute<ModelIdInput, unknown>('product_configurator.models.publish', { input: { id: modelId }, ctx })
  return true
}
