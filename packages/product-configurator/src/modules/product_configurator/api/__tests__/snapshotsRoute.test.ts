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
type QueryOptions = { filters: Record<string, { $eq?: string; $in?: string[] }>; page?: { page: number; pageSize: number } }

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()
const em = { fork: () => em }

const ORDER_ID = 'abababab-abab-4bab-8bab-abababababab'

const tables: Record<string, Row[]> = {
  'sales:sales_quote': [],
  'sales:sales_order': [],
  'sales:sales_quote_line': [],
  'sales:sales_order_line': [],
}

function matches(row: Row, filters: QueryOptions['filters']): boolean {
  return Object.entries(filters).every(([column, filter]) => {
    if (filter.$eq !== undefined) return row[column] === filter.$eq
    if (filter.$in !== undefined) return filter.$in.includes(String(row[column]))
    return true
  })
}

const queryMock = jest.fn(async (entity: string, options: QueryOptions) => {
  const items = (tables[entity] ?? []).filter((row) => matches(row, options.filters))
  if (!options.page) return { items }
  const offset = (options.page.page - 1) * options.page.pageSize
  return { items: items.slice(offset, offset + options.page.pageSize) }
})

let storedSnapshots: ConfigurationSnapshot[] = []

async function findStoredSnapshots(_em: unknown, entity: unknown, where: { id?: { $in?: string[] } }) {
  if (entity !== ConfigurationSnapshot) return []
  const ids = where.id?.$in
  return storedSnapshots.filter((stored) => !ids || ids.includes(stored.id))
}

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
    sales: {
      sales_quote: 'sales:sales_quote',
      sales_order: 'sales:sales_order',
      sales_quote_line: 'sales:sales_quote_line',
      sales_order_line: 'sales:sales_order_line',
    },
  }),
}))

import { GET, metadata } from '../snapshots/route'

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

function carrierLine(parent: 'quote_id' | 'order_id', snapshotId = SNAPSHOT_ID, id = LINE_ID, parentId = QUOTE_ID): Row {
  return {
    id,
    [parent]: parentId,
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
  tables['sales:sales_order'] = [{ id: ORDER_ID }]
  tables['sales:sales_quote_line'] = []
  tables['sales:sales_order_line'] = []
  getAuthFromRequestMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID })
  userHasAllFeaturesMock.mockResolvedValue(true)
  storedSnapshots = []
  findWithDecryptionMock.mockImplementation(findStoredSnapshots)
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

describe('GET /snapshots access per document', () => {
  it('requires only the snapshot feature in metadata and checks quote or order visibility in the handler', async () => {
    expect(metadata.GET.requireFeatures).toEqual(['product_configurator.snapshots.view'])

    tables['sales:sales_quote_line'] = [carrierLine('quote_id')]
    oneSnapshot(snapshot())
    await get(`id=${SNAPSHOT_ID}`)
    expect(userHasAllFeaturesMock).toHaveBeenLastCalledWith(USER_ID, ['product_configurator.snapshots.view', 'sales.quotes.view'], {
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })

    await get(`orderId=${ORDER_ID}`)
    expect(userHasAllFeaturesMock).toHaveBeenLastCalledWith(USER_ID, ['product_configurator.snapshots.view', 'sales.orders.view'], {
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })

    userHasAllFeaturesMock.mockResolvedValue(false)
    expect((await get(`orderId=${ORDER_ID}`)).status).toBe(403)
    expect((await get(`id=${SNAPSHOT_ID}&orderId=${ORDER_ID}`)).status).toBe(403)
  })

  it.each([`id=${SNAPSHOT_ID}&quoteId=${QUOTE_ID}`, `quoteId=${QUOTE_ID}&orderId=${ORDER_ID}`, ''])('answers 400 for %s', async (query) => {
    expect((await get(query)).status).toBe(400)
  })
})

describe('GET /snapshots?orderId=', () => {
  const OTHER_SNAPSHOT_ID = '00000000-0000-4000-8000-0000000000c1'
  const ORDER_LINE_ID = '00000000-0000-4000-8000-0000000000d1'

  function snapshotFindCalls(): Array<{ ids: string[]; options: unknown }> {
    return findWithDecryptionMock.mock.calls
      .filter(([, entity]) => entity === ConfigurationSnapshot)
      .map(([, , where, options]) => ({ ids: (where as { id: { $in: string[] } }).id.$in, options }))
  }

  function orderLineQueries() {
    return queryMock.mock.calls.filter(([entity]) => entity === 'sales:sales_order_line').map(([, options]) => options)
  }

  it('lists the snapshots the order lines carry with the order line id and name', async () => {
    tables['sales:sales_order_line'] = [
      carrierLine('order_id', SNAPSHOT_ID, LINE_ID, ORDER_ID),
      { ...carrierLine('order_id', OTHER_SNAPSHOT_ID, ORDER_LINE_ID, ORDER_ID), name: 'Second pump' },
      { id: '00000000-0000-4000-8000-0000000000e1', order_id: ORDER_ID, name: 'Plain line', configuration: null },
    ]
    storedSnapshots = [
      snapshot({ id: OTHER_SNAPSHOT_ID, createdAt: new Date('2026-11-06T11:00:00.000Z') }),
      snapshot({ quoteLineId: LINE_ID }),
    ]

    const response = await get(`orderId=${ORDER_ID}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: Array<Record<string, unknown>>; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(body.items.map((item) => [item.id, item.lineState, item.lineId, item.lineName])).toEqual([
      [SNAPSHOT_ID, 'present', LINE_ID, 'Configured pump'],
      [OTHER_SNAPSHOT_ID, 'present', ORDER_LINE_ID, 'Second pump'],
    ])
    expect(snapshotFindCalls()).toEqual([
      { ids: [SNAPSHOT_ID, OTHER_SNAPSHOT_ID], options: { fields: ['id', 'createdAt'] } },
      { ids: [SNAPSHOT_ID, OTHER_SNAPSHOT_ID], options: undefined },
    ])
    expect(findWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationSnapshot,
      { tenantId: TENANT_ID, organizationId: ORG_ID, id: { $in: [SNAPSHOT_ID, OTHER_SNAPSHOT_ID] } },
      undefined,
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
    expect(queryMock).toHaveBeenCalledWith('sales:sales_order_line', expect.objectContaining({ tenantId: TENANT_ID, organizationId: ORG_ID }))
  })

  it('narrows by ids to the snapshots a line of the order carries', async () => {
    tables['sales:sales_order_line'] = [carrierLine('order_id', SNAPSHOT_ID, LINE_ID, ORDER_ID)]
    storedSnapshots = [snapshot({ quoteLineId: LINE_ID }), snapshot({ id: OTHER_SNAPSHOT_ID, quoteLineId: ORDER_LINE_ID })]

    const narrowed = await get(`orderId=${ORDER_ID}&ids=${OTHER_SNAPSHOT_ID}`)
    expect(narrowed.status).toBe(200)
    await expect(narrowed.json()).resolves.toEqual({ items: [], truncated: false })

    const carried = await get(`orderId=${ORDER_ID}&ids=${SNAPSHOT_ID},${OTHER_SNAPSHOT_ID}`)
    const body = (await carried.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items.map((item) => [item.id, item.lineId])).toEqual([[SNAPSHOT_ID, LINE_ID]])
  })

  it('finds the order line of an unlinked snapshot by reading the order lines', async () => {
    tables['sales:sales_order_line'] = [carrierLine('order_id', SNAPSHOT_ID, ORDER_LINE_ID, ORDER_ID)]
    storedSnapshots = [snapshot()]
    const response = await get(`orderId=${ORDER_ID}&ids=${SNAPSHOT_ID}`)
    const body = (await response.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items.map((item) => [item.id, item.lineId])).toEqual([[SNAPSHOT_ID, ORDER_LINE_ID]])
  })

  it('keeps reads bounded above 500 configured lines: the list loads only the listed snapshots, an ids batch only its lines', async () => {
    const count = 1200
    const ids = Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    tables['sales:sales_order_line'] = ids.map((id) => carrierLine('order_id', id, id, ORDER_ID))
    storedSnapshots = ids.map((id, index) => snapshot({ id, quoteLineId: id, createdAt: new Date(Date.UTC(2026, 10, 6, 0, 0, index)) }))

    const list = await get(`orderId=${ORDER_ID}`)
    const listBody = (await list.json()) as { items: Array<{ id: string }>; truncated: boolean }
    expect(listBody.truncated).toBe(true)
    expect(listBody.items.map((item) => item.id)).toEqual(ids.slice(0, 500))
    const fullLoads = snapshotFindCalls().filter((call) => call.options === undefined)
    expect(fullLoads.flatMap((call) => call.ids)).toEqual(ids.slice(0, 500))

    findWithDecryptionMock.mockClear()
    queryMock.mockClear()
    const batch = ids.slice(900, 1000)
    const narrowed = await get(`orderId=${ORDER_ID}&ids=${batch.join(',')}`)
    const narrowedBody = (await narrowed.json()) as { items: Array<{ id: string; lineId: string }> }
    expect(narrowedBody.items.map((item) => item.lineId)).toEqual(batch)
    expect(orderLineQueries()).toEqual([expect.objectContaining({ filters: { id: { $in: batch }, order_id: { $eq: ORDER_ID } } })])
    expect(snapshotFindCalls()).toEqual([{ ids: batch, options: undefined }])
  })

  it('answers 404 order_not_found for an order outside the selected organization', async () => {
    tables['sales:sales_order'] = []
    const response = await get(`orderId=${ORDER_ID}`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'order_not_found' })
  })

  it('reads one snapshot by id only when a line of the order carries it', async () => {
    tables['sales:sales_order_line'] = [carrierLine('order_id', SNAPSHOT_ID, LINE_ID, ORDER_ID)]
    storedSnapshots = [snapshot({ quoteLineId: LINE_ID }), snapshot({ id: OTHER_SNAPSHOT_ID, quoteLineId: ORDER_LINE_ID })]
    const carried = await get(`id=${SNAPSHOT_ID}&orderId=${ORDER_ID}`)
    expect(carried.status).toBe(200)
    await expect(carried.json()).resolves.toMatchObject({ id: SNAPSHOT_ID, lineState: 'present', lineId: LINE_ID, lineName: 'Configured pump' })

    const missing = await get(`id=${OTHER_SNAPSHOT_ID}&orderId=${ORDER_ID}`)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'snapshot_not_found' })

    tables['sales:sales_order'] = []
    expect((await get(`id=${SNAPSHOT_ID}&orderId=${ORDER_ID}`)).status).toBe(404)
  })
})
