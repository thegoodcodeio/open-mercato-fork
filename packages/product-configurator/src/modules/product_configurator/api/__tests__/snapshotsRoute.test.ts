/** @jest-environment node */
import { ConfigurationSnapshot } from '../../data/entities'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444'
const LINE_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, unknown>
type QueryOptions = { filters: Record<string, { $eq?: string; $in?: string[] }> }

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()
const em = { fork: () => em }

const tables: Record<string, Row[]> = { 'sales:sales_quote': [], 'sales:sales_quote_line': [], 'sales:sales_order_line': [] }

function matches(row: Row, filters: QueryOptions['filters']): boolean {
  return Object.entries(filters).every(([column, filter]) => {
    if (filter.$eq !== undefined) return row[column] === filter.$eq
    if (filter.$in !== undefined) return filter.$in.includes(String(row[column]))
    return true
  })
}

const queryMock = jest.fn(async (entity: string, options: QueryOptions) => ({
  items: (tables[entity] ?? []).filter((row) => matches(row, options.filters)),
}))

const container = {
  resolve: (token: string) => {
    if (token === 'em') return em
    if (token === 'queryEngine') return { query: queryMock }
    if (token === 'rbacService') return { userHasAllFeatures: userHasAllFeaturesMock }
    return undefined
  },
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => container,
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: (...args: unknown[]) => resolveOrganizationScopeMock(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key, locale: 'en' }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({
    sales: { sales_quote: 'sales:sales_quote', sales_quote_line: 'sales:sales_quote_line', sales_order_line: 'sales:sales_order_line' },
  }),
}))

import { GET } from '../snapshots/route'

function snapshot(overrides: Partial<ConfigurationSnapshot> = {}): ConfigurationSnapshot {
  return Object.assign(new ConfigurationSnapshot(), {
    id: SNAPSHOT_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    sessionId: '88888888-8888-4888-8888-888888888888',
    quoteId: QUOTE_ID,
    quoteLineId: null,
    modelVersionId: VERSION_ID,
    modelVersionHash: 'v'.repeat(64),
    selections: { intent: {}, settled: {}, visibility: {} },
    calculated: {},
    bom: [],
    warnings: [],
    priceContext: {},
    netPrice: '10.0000',
    currencyCode: 'EUR',
    summary: 'Size: Small',
    hash: 'h'.repeat(64),
    createdAt: new Date('2026-11-06T10:00:00.000Z'),
    ...overrides,
  })
}

function carrierLine(parent: 'quote_id' | 'order_id', snapshotId = SNAPSHOT_ID, id = LINE_ID): Row {
  return {
    id,
    [parent]: QUOTE_ID,
    name: 'Configured pump',
    configuration: { productConfigurator: { snapshotId, modelVersionId: VERSION_ID, hash: 'h'.repeat(64), summary: 'Size: Small' } },
  }
}

function get(query: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/product_configurator/snapshots?${query}`))
}

function oneSnapshot(found: ConfigurationSnapshot | null) {
  findOneWithDecryptionMock.mockResolvedValue(found)
}

beforeEach(() => {
  jest.clearAllMocks()
  tables['sales:sales_quote'] = [{ id: QUOTE_ID, organization_id: ORG_ID, currency_code: 'EUR' }]
  tables['sales:sales_quote_line'] = []
  tables['sales:sales_order_line'] = []
  getAuthFromRequestMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID })
  userHasAllFeaturesMock.mockResolvedValue(true)
  findWithDecryptionMock.mockResolvedValue([])
})

describe('GET /snapshots?id=', () => {
  it('answers 404 for a pending snapshot that no line carries while the quote exists', async () => {
    oneSnapshot(snapshot())
    tables['sales:sales_quote_line'] = [carrierLine('quote_id', '99999999-9999-4999-8999-999999999999')]
    const response = await get(`id=${SNAPSHOT_ID}`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'snapshot_not_found' })
  })

  it('answers a committed but unlinked snapshot carried by a quote line as present', async () => {
    oneSnapshot(snapshot())
    tables['sales:sales_quote_line'] = [carrierLine('quote_id')]
    const response = await get(`id=${SNAPSHOT_ID}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: SNAPSHOT_ID, quoteLineId: null, lineState: 'present', lineName: 'Configured pump' })
  })

  it('answers a committed but unlinked snapshot carried by the order line once the quote is converted as present', async () => {
    oneSnapshot(snapshot())
    tables['sales:sales_quote'] = []
    tables['sales:sales_order_line'] = [carrierLine('order_id')]
    const response = await get(`id=${SNAPSHOT_ID}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ lineState: 'present', lineName: 'Configured pump' })
  })

  it('answers a linked snapshot whose line was removed as removed, not 404', async () => {
    oneSnapshot(snapshot({ quoteLineId: LINE_ID }))
    const response = await get(`id=${SNAPSHOT_ID}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ quoteLineId: LINE_ID, lineState: 'removed', lineName: null })
  })

  it('answers 404 for a snapshot outside the selected organization', async () => {
    oneSnapshot(null)
    expect((await get(`id=${SNAPSHOT_ID}`)).status).toBe(404)
    expect(findOneWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationSnapshot,
      { id: SNAPSHOT_ID, tenantId: TENANT_ID, organizationId: ORG_ID },
      undefined,
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
  })
})

describe('GET /snapshots?quoteId=', () => {
  function linkedSnapshots(count: number): ConfigurationSnapshot[] {
    return Array.from({ length: count }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      return snapshot({ id, quoteLineId: id })
    })
  }

  it.each([
    [500, 500, false],
    [501, 500, true],
  ])('reads %i stored snapshots as %i items with truncated %s', async (stored, listed, truncated) => {
    findWithDecryptionMock.mockResolvedValueOnce(linkedSnapshots(stored))
    const response = await get(`quoteId=${QUOTE_ID}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: unknown[]; truncated: boolean }
    expect(body.items).toHaveLength(listed)
    expect(body.truncated).toBe(truncated)
    expect(findWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationSnapshot,
      { tenantId: TENANT_ID, organizationId: ORG_ID, quoteId: QUOTE_ID },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit: 501 },
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
  })

  it('narrows by ids with the same 501 read limit and leaves pending snapshots out, carried unlinked ones in', async () => {
    const pending = snapshot({ id: '00000000-0000-4000-8000-0000000000a1' })
    const carried = snapshot({ id: '00000000-0000-4000-8000-0000000000a2' })
    const linked = snapshot({ id: '00000000-0000-4000-8000-0000000000a3', quoteLineId: LINE_ID })
    findWithDecryptionMock.mockResolvedValueOnce([pending, carried, linked])
    tables['sales:sales_quote_line'] = [carrierLine('quote_id', carried.id, '00000000-0000-4000-8000-0000000000b2')]
    const ids = [pending.id, carried.id, linked.id]

    const response = await get(`quoteId=${QUOTE_ID}&ids=${ids.join(',')}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: Array<{ id: string; lineState: string }>; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(body.items.map((item) => [item.id, item.lineState])).toEqual([
      [carried.id, 'present'],
      [linked.id, 'removed'],
    ])
    expect(findWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationSnapshot,
      { tenantId: TENANT_ID, organizationId: ORG_ID, quoteId: QUOTE_ID, id: { $in: ids } },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit: 501 },
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
  })

  it('answers 404 quote_not_found for a quote outside the selected organization', async () => {
    tables['sales:sales_quote'] = []
    const response = await get(`quoteId=${QUOTE_ID}`)
    expect(response.status).toBe(404)
    expect(findWithDecryptionMock).not.toHaveBeenCalled()
  })

  it('answers 400 for more ids than allowed', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    expect((await get(`quoteId=${QUOTE_ID}&ids=${ids.join(',')}`)).status).toBe(400)
  })
})
