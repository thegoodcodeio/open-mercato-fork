import type { EntityManager } from '@mikro-orm/postgresql'
import type { PricingContext } from '../../lib/pricing'
import { DefaultCatalogPriceRowService, type CatalogItemRef } from '../catalogPriceRowService'

type MockRecord = Record<string, unknown>

const mockStores: Record<string, MockRecord[]> = {}

function mockIdOf(value: unknown): unknown {
  if (value && typeof value === 'object' && 'id' in value) return (value as { id: unknown }).id
  return value
}

function mockMatches(record: MockRecord, where: MockRecord): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === '$and') return (condition as MockRecord[]).every((clause) => mockMatches(record, clause))
    if (key === '$or') return (condition as MockRecord[]).some((clause) => mockMatches(record, clause))
    const value = record[key]
    if (condition === null) return value === null || value === undefined
    if (typeof condition === 'object') {
      if ('$in' in (condition as MockRecord)) {
        return ((condition as { $in: unknown[] }).$in).includes(mockIdOf(value))
      }
      return value !== null && typeof value === 'object' && mockMatches(value as MockRecord, condition as MockRecord)
    }
    return mockIdOf(value) === condition
  })
}

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async (_em: unknown, entity: { name: string }, where: MockRecord) => {
    return (mockStores[entity.name] ?? []).filter((record) => mockMatches(record, where))
  }),
}))

const TENANT = 'tenant-1'
const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'tenant-2'
const scope = { tenantId: TENANT, organizationId: ORG }
const em = {} as EntityManager
const service = new DefaultCatalogPriceRowService()

function product(id: string, overrides: MockRecord = {}): MockRecord {
  return {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    sku: id.toUpperCase(),
    title: `Product ${id}`,
    taxRateId: null,
    defaultUnit: 'pc',
    defaultSalesUnitQuantity: '1',
    deletedAt: null,
    ...overrides,
  }
}

function variant(id: string, parent: MockRecord, overrides: MockRecord = {}): MockRecord {
  return {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    product: parent,
    sku: id.toUpperCase(),
    name: `Variant ${id}`,
    deletedAt: null,
    ...overrides,
  }
}

function priceKind(id: string, overrides: MockRecord = {}): MockRecord {
  return {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    code: id,
    currencyCode: null,
    isPromotion: false,
    isActive: true,
    deletedAt: null,
    ...overrides,
  }
}

function priceRow(id: string, target: { product: MockRecord; variant?: MockRecord }, kind: MockRecord, overrides: MockRecord = {}): MockRecord {
  return {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    product: target.product,
    variant: target.variant ?? null,
    offer: null,
    priceKind: kind,
    currencyCode: 'EUR',
    kind: 'regular',
    minQuantity: 1,
    unitPriceNet: '10.0000',
    customerId: null,
    customerGroupId: null,
    userId: null,
    userGroupId: null,
    channelId: null,
    ...overrides,
  }
}

const productSimple = product('p-1', { sku: 'P-1', defaultUnit: 'm', taxRateId: 'tax-1' })
const productWithoutSku = product('p-nosku', { sku: null })
const productDeleted = product('p-del', { sku: 'P-DEL', deletedAt: new Date('2026-01-01') })
const productOtherOrg = product('p-other-org', { sku: 'P-OTHER', organizationId: OTHER_ORG })
const productOtherTenant = product('p-other-tenant', { sku: 'P-OTHER', tenantId: OTHER_TENANT })
const productAmbiguous = product('p-amb', { sku: 'AMB' })
const productWithVariants = product('p-3', { sku: 'P-3', defaultUnit: 'kg', defaultSalesUnitQuantity: '2.000000' })
const productDeletedParent = product('p-gone', { sku: null, deletedAt: new Date('2026-01-01') })

const variantOne = variant('v-1', productWithVariants, { sku: 'V-1', name: 'Red' })
const variantTwo = variant('v-2', productWithVariants, { sku: 'V-2', name: null })
const variantThree = variant('v-3', productWithVariants, { sku: 'V-3' })
const variantDeleted = variant('v-del', productWithVariants, { sku: 'V-DEL', deletedAt: new Date('2026-01-01') })
const variantAmbiguous = variant('v-amb', productWithVariants, { sku: 'AMB' })
const variantOrphan = variant('v-orphan', productDeletedParent, { sku: 'V-ORPHAN' })
const variantOtherOrg = variant('v-other-org', productOtherOrg, { sku: 'V-OTHER', organizationId: OTHER_ORG })

const kindRegular = priceKind('pk-regular')
const kindGlobal = priceKind('pk-global', { organizationId: null })
const kindPromo = priceKind('pk-promo', { isPromotion: true })
const kindDeleted = priceKind('pk-deleted', { deletedAt: new Date('2026-01-01') })
const kindInactive = priceKind('pk-inactive', { isActive: false })
const kindOtherOrg = priceKind('pk-other-org', { organizationId: OTHER_ORG })
const kindOtherTenant = priceKind('pk-other-tenant', { tenantId: OTHER_TENANT, organizationId: null })

beforeEach(() => {
  mockStores.CatalogProduct = [
    productSimple,
    productWithoutSku,
    productDeleted,
    productOtherOrg,
    productOtherTenant,
    productAmbiguous,
    productWithVariants,
    productDeletedParent,
  ]
  mockStores.CatalogProductVariant = [
    variantOne,
    variantTwo,
    variantThree,
    variantDeleted,
    variantAmbiguous,
    variantOrphan,
    variantOtherOrg,
  ]
  mockStores.CatalogPriceKind = [kindRegular, kindGlobal, kindPromo, kindDeleted, kindInactive, kindOtherOrg, kindOtherTenant]
  mockStores.CatalogProductPrice = [
    priceRow('row-p1', { product: productSimple }, kindRegular),
    priceRow('row-p1-promo', { product: productSimple }, kindPromo, { unitPriceNet: '8.0000' }),
    priceRow('row-p1-deleted-kind', { product: productSimple }, kindDeleted),
    priceRow('row-p1-inactive-kind', { product: productSimple }, kindInactive),
    priceRow('row-p1-usd', { product: productSimple }, kindRegular, { currencyCode: 'USD' }),
    priceRow('row-p1-other-org', { product: productSimple }, kindRegular, { organizationId: OTHER_ORG }),
    priceRow('row-p3', { product: productWithVariants }, kindRegular),
    priceRow('row-v1', { product: productWithVariants, variant: variantOne }, kindRegular),
    priceRow('row-v2', { product: productWithVariants, variant: variantTwo }, kindRegular),
  ]
})

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return { currencyCode: 'EUR', priceKindId: 'pk-regular', quantity: 1, date: new Date('2026-06-01'), ...overrides }
}

function item(sku: string, productId: string, variantId: string | null = null): CatalogItemRef {
  return { sku, productId, variantId, title: sku, unit: 'pc', salesUnitQuantity: '1' }
}

function rowIds(rows: Map<string, Array<{ id: string }>>, sku: string): string[] {
  return (rows.get(sku) ?? []).map((row) => row.id).sort()
}

describe('DefaultCatalogPriceRowService.resolveProducts', () => {
  it('returns live products in scope, including a product without a SKU', async () => {
    const result = await service.resolveProducts(
      em,
      ['p-1', 'p-nosku', 'p-del', 'p-other-org', 'p-other-tenant', 'missing'],
      scope,
    )

    expect(Array.from(result.keys()).sort()).toEqual(['p-1', 'p-nosku'])
    expect(result.get('p-1')).toEqual({ productId: 'p-1', sku: 'P-1', title: 'Product p-1', taxRateId: 'tax-1' })
    expect(result.get('p-nosku')?.sku).toBeNull()
  })

  it('returns an empty map for no ids', async () => {
    expect((await service.resolveProducts(em, [], scope)).size).toBe(0)
  })
})

describe('DefaultCatalogPriceRowService.resolveSkus', () => {
  it('resolves product and variant SKUs with the product base unit and sales unit quantity', async () => {
    const { items, ambiguous } = await service.resolveSkus(em, ['P-1', 'V-1', 'V-2'], scope)

    expect(ambiguous).toEqual([])
    expect(items.get('P-1')).toEqual({
      sku: 'P-1',
      productId: 'p-1',
      variantId: null,
      title: 'Product p-1',
      unit: 'm',
      salesUnitQuantity: '1',
    })
    expect(items.get('V-1')).toEqual({
      sku: 'V-1',
      productId: 'p-3',
      variantId: 'v-1',
      title: 'Red',
      unit: 'kg',
      salesUnitQuantity: '2.000000',
    })
    expect(items.get('V-2')?.title).toBe('Product p-3')
  })

  it('returns a SKU found on both a product and a variant as ambiguous', async () => {
    const { items, ambiguous } = await service.resolveSkus(em, ['AMB', 'P-1'], scope)

    expect(ambiguous).toEqual(['AMB'])
    expect(items.has('AMB')).toBe(false)
    expect(items.has('P-1')).toBe(true)
  })

  it('excludes soft-deleted products, soft-deleted variants and variants of soft-deleted products', async () => {
    const { items, ambiguous } = await service.resolveSkus(em, ['P-DEL', 'V-DEL', 'V-ORPHAN'], scope)

    expect(items.size).toBe(0)
    expect(ambiguous).toEqual([])
  })

  it('never resolves SKUs of another organization or tenant', async () => {
    const { items } = await service.resolveSkus(em, ['P-OTHER', 'V-OTHER'], scope)

    expect(items.size).toBe(0)
  })

  it('rejects more than 500 distinct SKUs', async () => {
    const skus = Array.from({ length: 501 }, (_, index) => `SKU-${index}`)

    await expect(service.resolveSkus(em, skus, scope)).rejects.toThrow('at most 500 SKUs')
  })

  it('accepts 500 distinct SKUs when duplicates push the raw list over the limit', async () => {
    const skus = Array.from({ length: 500 }, (_, index) => `SKU-${index}`)

    await expect(service.resolveSkus(em, [...skus, 'SKU-0'], scope)).resolves.toEqual({ items: new Map(), ambiguous: [] })
  })
})

describe('DefaultCatalogPriceRowService.resolvePriceKinds', () => {
  it('returns active price kinds of the organization and of no organization', async () => {
    const result = await service.resolvePriceKinds(
      em,
      ['pk-regular', 'pk-global', 'pk-promo', 'pk-deleted', 'pk-inactive', 'pk-other-org', 'pk-other-tenant'],
      scope,
    )

    expect(Array.from(result.keys()).sort()).toEqual(['pk-global', 'pk-promo', 'pk-regular'])
    expect(result.get('pk-global')).toEqual({ id: 'pk-global', code: 'pk-global', currencyCode: null, isPromotion: false })
    expect(result.get('pk-promo')?.isPromotion).toBe(true)
  })
})

describe('DefaultCatalogPriceRowService.findPriceRows', () => {
  it('returns product rows filtered by the pricing context, scope and usable price kinds', async () => {
    const rows = await service.findPriceRows(em, [item('P-1', 'p-1')], context(), scope)

    expect(rowIds(rows, 'P-1')).toEqual(['row-p1', 'row-p1-promo'])
  })

  it('drops promotional price kinds when excludePromotions is set', async () => {
    const rows = await service.findPriceRows(em, [item('P-1', 'p-1')], context(), scope, { excludePromotions: true })

    expect(rowIds(rows, 'P-1')).toEqual(['row-p1'])
  })

  it('gives a product SKU product-level rows only, never variant rows', async () => {
    const rows = await service.findPriceRows(em, [item('P-3', 'p-3')], context(), scope)

    expect(rowIds(rows, 'P-3')).toEqual(['row-p3'])
  })

  it('gives a variant SKU its product rows plus its own rows, never a sibling variant row', async () => {
    const rows = await service.findPriceRows(
      em,
      [item('P-3', 'p-3'), item('V-1', 'p-3', 'v-1'), item('V-3', 'p-3', 'v-3')],
      context(),
      scope,
    )

    expect(rowIds(rows, 'P-3')).toEqual(['row-p3'])
    expect(rowIds(rows, 'V-1')).toEqual(['row-p3', 'row-v1'])
    expect(rowIds(rows, 'V-3')).toEqual(['row-p3'])
  })

  it('adds a customer-group row only for a group in the pricing context', async () => {
    mockStores.CatalogProductPrice.push(
      priceRow('row-p1-group', { product: productSimple }, kindRegular, { customerGroupId: 'group-1', unitPriceNet: '9.0000' }),
      priceRow('row-p1-other-group', { product: productSimple }, kindRegular, { customerGroupId: 'group-2' }),
    )

    const withGroup = await service.findPriceRows(em, [item('P-1', 'p-1')], context({ customerGroupIds: ['group-1'] }), scope)
    const withoutGroup = await service.findPriceRows(em, [item('P-1', 'p-1')], context(), scope)

    expect(rowIds(withGroup, 'P-1')).toEqual(['row-p1', 'row-p1-group', 'row-p1-promo'])
    expect(rowIds(withoutGroup, 'P-1')).toEqual(['row-p1', 'row-p1-promo'])
  })

  it('returns every quantity tier for a total below one (0.5 m), leaving the tier pick to the caller', async () => {
    mockStores.CatalogProductPrice.push(
      priceRow('row-p1-tier-10', { product: productSimple }, kindRegular, { minQuantity: 10, unitPriceNet: '9.5000' }),
    )

    const rows = await service.findPriceRows(em, [item('P-1', 'p-1')], context({ quantity: 0.5 }), scope, { excludePromotions: true })

    expect(rowIds(rows, 'P-1')).toEqual(['row-p1', 'row-p1-tier-10'])
  })

  it('returns an empty list for an item without rows', async () => {
    const rows = await service.findPriceRows(em, [item('P-NOSKU', 'p-nosku')], context(), scope)

    expect(rows.get('P-NOSKU')).toEqual([])
  })

  it('rejects more than 500 distinct SKUs', async () => {
    const items = Array.from({ length: 501 }, (_, index) => item(`SKU-${index}`, 'p-1'))

    await expect(service.findPriceRows(em, items, context(), scope)).rejects.toThrow('at most 500 SKUs')
  })
})
