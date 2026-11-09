/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import { DefaultCatalogPriceRowService } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import { DefaultCatalogPricingService } from '@open-mercato/core/modules/catalog/services/catalogPricingService'
import { definitionSchema, type ConfigurationDefinitionInput } from '../../data/validators'
import { evaluateConfiguration } from '../evaluation'
import { ConfiguratorEvaluationError } from '../evaluator/errors'
import { resolveCustomerGroupIds, resolveUnitPrices, tierQuantity, type PricingInput } from '../pricing'

type MockRecord = Record<string, unknown>

const mockStores: Record<string, MockRecord[]> = {}

function mockIdOf(value: unknown): unknown {
  if (value && typeof value === 'object' && 'id' in value) return (value as { id: unknown }).id
  return value
}

/** Enough of the MikroORM filter language for the catalog service queries ($and, $or, $in, null, nested relations). */
function mockMatches(record: MockRecord, where: MockRecord): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === '$and') return (condition as MockRecord[]).every((clause) => mockMatches(record, clause))
    if (key === '$or') return (condition as MockRecord[]).some((clause) => mockMatches(record, clause))
    const value = record[key]
    if (condition === null) return value === null || value === undefined
    if (typeof condition === 'object') {
      if ('$in' in (condition as MockRecord)) return (condition as { $in: unknown[] }).$in.includes(mockIdOf(value))
      return value !== null && typeof value === 'object' && mockMatches(value as MockRecord, condition as MockRecord)
    }
    return mockIdOf(value) === condition
  })
}

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async (_em: unknown, entity: { name: string }, where: MockRecord) =>
    (mockStores[entity.name] ?? []).filter((record) => mockMatches(record, where)),
  ),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const PRICE_KIND = '33333333-3333-4333-8333-333333333333'
const PROMO_KIND = '44444444-4444-4444-8444-444444444444'
const GROUP_A = '55555555-5555-4555-8555-555555555555'
const CUSTOMER = '66666666-6666-4666-8666-666666666666'
const CHANNEL = '77777777-7777-4777-8777-777777777777'
const AT = new Date('2026-11-06T10:00:00.000Z')
const em = {} as EntityManager

function product(id: string, sku: string, defaultUnit: string): MockRecord {
  return { id, tenantId: TENANT, organizationId: ORG, sku, title: `Product ${sku}`, defaultUnit, defaultSalesUnitQuantity: '1', deletedAt: null }
}

function variant(id: string, sku: string, parent: MockRecord, name: string): MockRecord {
  return { id, tenantId: TENANT, organizationId: ORG, product: parent, sku, name, deletedAt: null }
}

function priceKind(id: string, isPromotion = false): MockRecord {
  return { id, tenantId: TENANT, organizationId: ORG, code: id, isPromotion, isActive: true, deletedAt: null }
}

function priceRow(id: string, target: { product: MockRecord; variant?: MockRecord }, unitPriceNet: string, overrides: MockRecord = {}): MockRecord {
  return {
    id,
    tenantId: TENANT,
    organizationId: ORG,
    product: target.product,
    variant: target.variant ?? null,
    offer: null,
    priceKind: kindRegular,
    currencyCode: 'EUR',
    kind: 'regular',
    minQuantity: 1,
    maxQuantity: null,
    unitPriceNet,
    customerId: null,
    customerGroupId: null,
    userId: null,
    userGroupId: null,
    channelId: null,
    startsAt: null,
    endsAt: null,
    ...overrides,
  }
}

const kindRegular = priceKind(PRICE_KIND)
const kindPromo = priceKind(PROMO_KIND, true)
const frame = product('p-frame', 'FRAME', 'pc')
const panel = product('p-panel', 'PANEL', 'pc')
const panelBlue = variant('v-panel-blue', 'PANEL-BLUE', panel, 'Blue panel')
const panelRed = variant('v-panel-red', 'PANEL-RED', panel, 'Red panel')
const cable = product('p-cable', 'CABLE', 'm')

beforeEach(() => {
  mockStores.CatalogProduct = [frame, panel, cable]
  mockStores.CatalogProductVariant = [panelBlue, panelRed]
  mockStores.CatalogProductPrice = [
    priceRow('frame-base', { product: frame }, '100.0000'),
    priceRow('frame-group', { product: frame }, '80.0000', { customerGroupId: GROUP_A }),
    priceRow('frame-channel', { product: frame }, '70.0000', { channelId: CHANNEL }),
    priceRow('frame-promo', { product: frame }, '50.0000', { priceKind: kindPromo }),
    priceRow('frame-usd', { product: frame }, '1.0000', { currencyCode: 'USD' }),
    priceRow('panel-base', { product: panel }, '45.5000'),
    priceRow('panel-red', { product: panel, variant: panelRed }, '60.0000'),
    priceRow('cable-tier-1', { product: cable }, '12.3456'),
    priceRow('cable-tier-10', { product: cable }, '9.0000', { kind: 'tier', minQuantity: 10 }),
  ]
})

type Services = { customerGroupsService?: { resolveGroups: jest.Mock } }

function container(services: Services = {}) {
  const registry: Record<string, unknown> = {
    catalogPriceRowService: new DefaultCatalogPriceRowService(),
    catalogPricingService: new DefaultCatalogPricingService(),
    ...services,
  }
  return {
    resolve: (name: string) => {
      if (!(name in registry)) throw new Error(`Could not resolve '${name}'`)
      return registry[name]
    },
  }
}

function groupsService(groupIds: string[]) {
  return { resolveGroups: jest.fn(async () => ({ groupIds, groups: [] })) }
}

function pricingInput(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    em,
    container: container(),
    scope: { tenantId: TENANT, organizationId: ORG },
    currencyCode: 'EUR',
    priceKindId: PRICE_KIND,
    allowPromotions: false,
    channelId: null,
    customerId: null,
    at: AT,
    ...overrides,
  }
}

function definitionInput(): ConfigurationDefinitionInput {
  return {
    schemaVersion: 1,
    commercial: { currencyCode: 'EUR', priceKindId: PRICE_KIND },
    fixedSpecification: [],
    features: [
      { key: 'length', label: 'Cable length', type: 'number', min: 0.5, max: 20, step: 0.5, unit: 'm', default: 0.5, order: 1, inSummary: true },
    ],
    rules: [],
    formulas: [{ key: 'cable_m', expr: { kind: 'feature', featureKey: 'length' }, unit: 'm', decimals: 1 }],
    lookups: [],
    bom: [
      { id: 'frame', sku: 'FRAME', uom: 'pc', quantity: 1, when: [], order: 1 },
      { id: 'panel', sku: 'PANEL-BLUE', uom: 'pc', quantity: 2, when: [], order: 2 },
      { id: 'cable', sku: 'CABLE', uom: 'm', quantity: { formulaKey: 'cable_m' }, when: [], order: 3 },
    ],
  }
}

async function evaluate(selections: Record<string, number>, pricing: Partial<PricingInput>) {
  const { em: pricingEm, container: pricingContainer, scope, channelId, customerId, at } = pricingInput(pricing)
  return evaluateConfiguration({
    definition: definitionSchema.parse(definitionInput()),
    modelVersion: { id: 'version-1', hash: 'b'.repeat(64) },
    selections,
    pricing: { em: pricingEm, container: pricingContainer, scope, channelId, customerId, at },
  })
}

function lineTotals(result: Awaited<ReturnType<typeof evaluate>>) {
  return result.bom.map((line) => [line.bomId, line.sku, line.label, line.quantity, line.unitPrice, line.total])
}

describe('customer groups for pricing', () => {
  it('gives no groups when customer_groups is not registered', async () => {
    await expect(resolveCustomerGroupIds(container(), { customerId: CUSTOMER, tenantId: TENANT, at: AT })).resolves.toEqual([])
  })

  it('asks the service for the customer at the evaluation time, also without a customer (tenant default group)', async () => {
    const service = groupsService([GROUP_A])
    await expect(resolveCustomerGroupIds(container({ customerGroupsService: service }), { customerId: CUSTOMER, tenantId: TENANT, at: AT })).resolves.toEqual([GROUP_A])
    expect(service.resolveGroups).toHaveBeenCalledWith({ customerId: CUSTOMER, customerIds: [CUSTOMER], tenantId: TENANT, at: AT })
    await resolveCustomerGroupIds(container({ customerGroupsService: service }), { customerId: null, tenantId: TENANT, at: AT })
    expect(service.resolveGroups).toHaveBeenLastCalledWith({ customerId: null, customerIds: [], tenantId: TENANT, at: AT })
  })
})

describe('resolveUnitPrices', () => {
  it('prices with customerGroupIds [] when customer_groups is not registered, in row fetching and selection', async () => {
    const rowService = new DefaultCatalogPriceRowService()
    const pricingService = new DefaultCatalogPricingService()
    const findPriceRows = jest.spyOn(rowService, 'findPriceRows')
    const resolvePriceMany = jest.spyOn(pricingService, 'resolvePriceMany')
    const services = { catalogPriceRowService: rowService, catalogPricingService: pricingService }
    const result = await resolveUnitPrices(
      pricingInput({ customerId: CUSTOMER, container: { resolve: (name: string) => services[name as keyof typeof services] } }),
      [{ sku: 'FRAME', quantity: '1' }],
    )
    expect(result.unitPrices).toEqual({ FRAME: '100.0000' })
    expect(result.priceContext).toEqual({
      currencyCode: 'EUR',
      priceKindId: PRICE_KIND,
      allowPromotions: false,
      channelId: null,
      customerId: CUSTOMER,
      customerIds: [CUSTOMER],
      customerGroupIds: [],
      date: AT.toISOString(),
    })
    expect(findPriceRows.mock.calls[0][2]).toMatchObject({ customerGroupIds: [], customerIds: [CUSTOMER], quantity: 1 })
    expect(findPriceRows.mock.calls[0][4]).toEqual({ excludePromotions: true })
    expect(resolvePriceMany.mock.calls[0][0][0].context).toMatchObject({ customerGroupIds: [], quantity: 1, date: AT })
  })

  it('applies the customer-group row for a member of the group and the base row otherwise', async () => {
    const member = await resolveUnitPrices(pricingInput({ container: container({ customerGroupsService: groupsService([GROUP_A]) }), customerId: CUSTOMER }), [
      { sku: 'FRAME', quantity: '1' },
    ])
    expect(member.unitPrices).toEqual({ FRAME: '80.0000' })
    expect(member.priceContext.customerGroupIds).toEqual([GROUP_A])
    const other = await resolveUnitPrices(pricingInput({ container: container({ customerGroupsService: groupsService([]) }) }), [{ sku: 'FRAME', quantity: '1' }])
    expect(other.unitPrices).toEqual({ FRAME: '100.0000' })
  })

  it('prefers the channel row over the base row for the quote channel', async () => {
    const result = await resolveUnitPrices(pricingInput({ channelId: CHANNEL }), [{ sku: 'FRAME', quantity: '1' }])
    expect(result.unitPrices).toEqual({ FRAME: '70.0000' })
  })

  it('uses promotion rows only when the model allows promotions', async () => {
    const result = await resolveUnitPrices(pricingInput({ allowPromotions: true }), [{ sku: 'FRAME', quantity: '1' }])
    expect(result.unitPrices).toEqual({ FRAME: '50.0000' })
  })

  it('prices a variant without its own row from its product row, never from a sibling variant', async () => {
    const result = await resolveUnitPrices(pricingInput(), [{ sku: 'PANEL-BLUE', quantity: '2' }])
    expect(result.unitPrices).toEqual({ 'PANEL-BLUE': '45.5000' })
    expect(result.labels).toEqual({ 'PANEL-BLUE': 'Blue panel' })
    const red = await resolveUnitPrices(pricingInput(), [{ sku: 'PANEL-RED', quantity: '1' }])
    expect(red.unitPrices).toEqual({ 'PANEL-RED': '60.0000' })
  })

  it('picks the tier with the total SKU quantity, and the first tier for a total below 1', async () => {
    expect(tierQuantity('0.5')).toBe(1)
    expect(tierQuantity('12')).toBe(12)
    const short = await resolveUnitPrices(pricingInput(), [{ sku: 'CABLE', quantity: '0.5' }])
    expect(short.unitPrices).toEqual({ CABLE: '12.3456' })
    const long = await resolveUnitPrices(pricingInput(), [{ sku: 'CABLE', quantity: '12' }])
    expect(long.unitPrices).toEqual({ CABLE: '9.0000' })
  })

  it('fails with price_missing for an unknown SKU or a SKU with no row in the currency', async () => {
    const unknown = resolveUnitPrices(pricingInput(), [{ sku: 'NOPE', quantity: '1' }])
    await expect(unknown).rejects.toBeInstanceOf(ConfiguratorEvaluationError)
    await expect(unknown).rejects.toMatchObject({ code: 'price_missing', params: { skus: ['NOPE'], channelId: null } })
    const noRow = resolveUnitPrices(pricingInput({ currencyCode: 'PLN', channelId: CHANNEL }), [{ sku: 'FRAME', quantity: '1' }])
    await expect(noRow).rejects.toMatchObject({ code: 'price_missing', params: { skus: ['FRAME'], channelId: CHANNEL } })
  })

  it('does not call catalog for an empty BOM', async () => {
    const result = await resolveUnitPrices(pricingInput({ container: { resolve: () => { throw new Error('unexpected') } } }), [])
    expect(result.unitPrices).toEqual({})
    expect(result.priceContext.customerGroupIds).toEqual([])
  })
})

describe('golden values priced through catalog (evaluateConfiguration)', () => {
  // Worked out by hand from the rows above, not from the engine:
  // frame: group row 80.0000 x 1 = 80.00 for a member of GROUP_A (base row 100.0000 otherwise)
  // panel: PANEL-BLUE has no own row, so its product row 45.5000 applies: x 2 = 91.00 (the PANEL-RED row 60.0000 never does)
  // cable: 0.5 m total is priced from the first tier (minQuantity 1) 12.3456: x 0.5 = 6.1728 -> 6.17
  it('prices a BOM part with the customer-group price, a variant from its product row and a 0.5 m total from the first tier', async () => {
    const result = await evaluate({ length: 0.5 }, { container: container({ customerGroupsService: groupsService([GROUP_A]) }), customerId: CUSTOMER })
    expect(lineTotals(result)).toEqual([
      ['frame', 'FRAME', 'Product FRAME', '1', '80', '80.00'],
      ['panel', 'PANEL-BLUE', 'Blue panel', '2', '45.5', '91.00'],
      ['cable', 'CABLE', 'Product CABLE', '0.5', '12.3456', '6.17'],
    ])
    expect(result.netPrice).toBe('177.17')
    expect(result.finalisable).toBe(true)
    expect(result.summary).toBe('Cable length: 0.5 m')
    expect(result.priceContext).toMatchObject({ customerId: CUSTOMER, customerGroupIds: [GROUP_A], channelId: null })
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  // Without the group: frame 100.00 + panel 91.00 + cable 6.17 = 197.17
  // With 12 m: the 10 m tier 9.0000 x 12 = 108.00, so 100.00 + 91.00 + 108.00 = 299.00
  it('prices the same choices at the base row without the group, and a 12 m total from the second tier', async () => {
    const base = await evaluate({ length: 0.5 }, {})
    expect(base.netPrice).toBe('197.17')
    const long = await evaluate({ length: 12 }, {})
    expect(lineTotals(long)[2]).toEqual(['cable', 'CABLE', 'Product CABLE', '12', '9', '108.00'])
    expect(long.netPrice).toBe('299.00')
    expect(long.hash).not.toBe(base.hash)
  })
})
