/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CatalogItemRef } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import { ConfigurationModel } from '../../data/entities'
import { REFERENCE_BOUND_PRODUCT, REFERENCE_MODEL_KEY, REFERENCE_PARTS } from '../referenceModel'
import { seedReferenceModel } from '../seeds'

const findOneWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({ catalog: { catalog_price_kind: 'catalog:catalog_price_kind' } }),
}))

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const em = {} as EntityManager
const PRICE_KIND_ID = 'pk-regular'

function setup(
  options: {
    model?: unknown
    priceKinds?: Array<{ id: string; organization_id: string | null }>
    existingSkus?: string[]
    variantSkus?: string[]
    pricedSkus?: string[]
  } = {},
) {
  findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === ConfigurationModel) return options.model ?? null
    return null
  })
  const query = jest.fn(async () => ({ items: options.priceKinds ?? [{ id: PRICE_KIND_ID, organization_id: null }], total: 1 }))
  let createdProducts = 0
  const execute = jest.fn(async (commandId: string, _options: { input: Record<string, unknown> }) => {
    if (commandId === 'catalog.products.create') {
      createdProducts += 1
      return { result: { productId: `product-${createdProducts}` }, logEntry: null }
    }
    if (commandId === 'product_configurator.models.create') return { result: { id: 'model-1' }, logEntry: null }
    return { result: {}, logEntry: null }
  })
  const existing = new Map<string, CatalogItemRef>(
    (options.existingSkus ?? []).map((sku) => [
      sku,
      {
        sku,
        productId: `existing-${sku}`,
        variantId: options.variantSkus?.includes(sku) ? `variant-${sku}` : null,
        title: sku,
        unit: 'pc',
        salesUnitQuantity: '1',
      },
    ]),
  )
  const resolveSkus = jest.fn(async () => ({ items: existing, ambiguous: [] }))
  const priced = new Set(options.pricedSkus ?? [])
  const findPriceRows = jest.fn(async (_em: unknown, items: CatalogItemRef[]) =>
    new Map(items.map((item) => [item.sku, priced.has(item.sku) ? [{ id: `price-${item.sku}` }] : []])),
  )
  const container = {
    resolve: (token: string) => {
      if (token === 'commandBus') return { execute }
      if (token === 'catalogPriceRowService') return { resolveSkus, findPriceRows }
      if (token === 'queryEngine') return { query }
      return undefined
    },
  } as unknown as AwilixContainer
  return { container, execute, query, findPriceRows }
}

function commandIds(execute: jest.Mock) {
  return execute.mock.calls.map(([commandId]) => commandId)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('seedReferenceModel', () => {
  it('creates the catalog products and prices through catalog commands, then creates and publishes the model', async () => {
    const { container, execute } = setup()

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(true)

    const ids = commandIds(execute)
    expect(ids.filter((id) => id === 'catalog.products.create')).toHaveLength(REFERENCE_PARTS.length + 1)
    expect(ids.filter((id) => id === 'catalog.prices.create')).toHaveLength(REFERENCE_PARTS.length)
    expect(ids.slice(-2)).toEqual(['product_configurator.models.create', 'product_configurator.models.publish'])

    const [, modelCreate] = execute.mock.calls[execute.mock.calls.length - 2]
    expect(modelCreate.input).toMatchObject({
      productId: 'product-1',
      modelKey: REFERENCE_MODEL_KEY,
      currencyCode: 'USD',
      priceKindId: PRICE_KIND_ID,
      draftDefinition: expect.objectContaining({ commercial: expect.objectContaining({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID }) }),
    })
    const [, publish] = execute.mock.calls[execute.mock.calls.length - 1]
    expect(publish).toMatchObject({
      input: { id: 'model-1' },
      ctx: {
        auth: null,
        systemActor: true,
        selectedOrganizationId: scope.organizationId,
        organizationScope: { tenantId: scope.tenantId, allowedIds: [scope.organizationId] },
      },
    })
  })

  it('reads the regular price kind through the query engine and prefers the organization one', async () => {
    const { container, execute, query } = setup({
      priceKinds: [
        { id: 'pk-tenant', organization_id: null },
        { id: 'pk-org', organization_id: scope.organizationId },
      ],
    })

    await seedReferenceModel(em, container, scope)

    expect(query).toHaveBeenCalledWith('catalog:catalog_price_kind', {
      tenantId: scope.tenantId,
      organizationIds: [scope.organizationId, ''],
      filters: { code: { $eq: 'regular' }, is_active: { $eq: true } },
      fields: ['id', 'organization_id'],
      page: { page: 1, pageSize: 10 },
    })
    const modelCreate = execute.mock.calls.find(([commandId]) => commandId === 'product_configurator.models.create')
    expect(modelCreate?.[1].input.priceKindId).toBe('pk-org')
  })

  it('reuses catalog products that already carry a reference SKU', async () => {
    const { container, execute } = setup({
      existingSkus: [REFERENCE_BOUND_PRODUCT.sku, 'TH-CHASSIS'],
      pricedSkus: ['TH-CHASSIS'],
    })

    await seedReferenceModel(em, container, scope)

    const productSkus = execute.mock.calls
      .filter(([commandId]) => commandId === 'catalog.products.create')
      .map(([, options]) => options.input.sku)
    expect(productSkus).not.toContain('TH-CHASSIS')
    expect(productSkus).not.toContain(REFERENCE_BOUND_PRODUCT.sku)
    const modelCreate = execute.mock.calls.find(([commandId]) => commandId === 'product_configurator.models.create')
    expect(modelCreate?.[1].input.productId).toBe(`existing-${REFERENCE_BOUND_PRODUCT.sku}`)
  })

  it('creates the missing price of a reused product left behind by a failed run', async () => {
    const reusedSkus = [REFERENCE_BOUND_PRODUCT.sku, ...REFERENCE_PARTS.map((part) => part.sku)]
    const { container, execute, findPriceRows } = setup({
      existingSkus: reusedSkus,
      pricedSkus: REFERENCE_PARTS.slice(1).map((part) => part.sku),
    })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(true)

    expect(commandIds(execute)).toEqual(['catalog.prices.create', 'product_configurator.models.create', 'product_configurator.models.publish'])
    const [, priceCreate] = execute.mock.calls[0]
    expect(priceCreate.input).toMatchObject({
      productId: `existing-${REFERENCE_PARTS[0].sku}`,
      priceKindId: PRICE_KIND_ID,
      currencyCode: 'USD',
      unitPriceNet: REFERENCE_PARTS[0].unitPriceNet,
    })
    expect(findPriceRows).toHaveBeenCalledWith(
      em,
      expect.arrayContaining([expect.objectContaining({ sku: REFERENCE_PARTS[0].sku })]),
      { priceKindId: PRICE_KIND_ID, currencyCode: 'USD', quantity: 1, date: expect.any(Date) },
      scope,
      { excludePromotions: true },
    )
  })

  it('creates the missing price of a reused variant on the variant, not on its parent product', async () => {
    const reusedSkus = [REFERENCE_BOUND_PRODUCT.sku, ...REFERENCE_PARTS.map((part) => part.sku)]
    const variantSku = REFERENCE_PARTS[0].sku
    const { container, execute } = setup({
      existingSkus: reusedSkus,
      variantSkus: [variantSku],
      pricedSkus: REFERENCE_PARTS.slice(1).map((part) => part.sku),
    })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(true)

    const priceCreates = execute.mock.calls.filter(([commandId]) => commandId === 'catalog.prices.create')
    expect(priceCreates).toHaveLength(1)
    expect(priceCreates[0][1].input).toMatchObject({
      productId: `existing-${variantSku}`,
      variantId: `variant-${variantSku}`,
      unitPriceNet: REFERENCE_PARTS[0].unitPriceNet,
    })
  })

  it('skips with a warning when the unpublished reference model is bound to a product that no longer carries the reference SKU', async () => {
    const { container, execute } = setup({
      model: { id: 'model-left-unpublished', latestVersionId: null, productId: 'deleted-product' },
    })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('publishes an existing reference model that has no published version yet', async () => {
    const reusedSkus = [REFERENCE_BOUND_PRODUCT.sku, ...REFERENCE_PARTS.map((part) => part.sku)]
    const { container, execute } = setup({
      model: { id: 'model-left-unpublished', latestVersionId: null, productId: `existing-${REFERENCE_BOUND_PRODUCT.sku}` },
      existingSkus: reusedSkus,
      pricedSkus: REFERENCE_PARTS.map((part) => part.sku),
    })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(true)

    expect(commandIds(execute)).toEqual(['product_configurator.models.publish'])
    expect(execute.mock.calls[0][1].input).toEqual({ id: 'model-left-unpublished' })
  })

  it('does nothing when the reference model is already published', async () => {
    const { container, execute } = setup({ model: { id: 'model-1', latestVersionId: 'version-1' } })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('does nothing without a regular price kind', async () => {
    const { container, execute } = setup({ priceKinds: [] })

    await expect(seedReferenceModel(em, container, scope)).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})
