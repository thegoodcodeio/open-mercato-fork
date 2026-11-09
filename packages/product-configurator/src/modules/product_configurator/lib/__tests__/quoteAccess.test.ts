/** @jest-environment node */
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import {
  assertFeatures,
  customerNameFromSnapshot,
  findLineCarryingSnapshot,
  readConfigurationMarker,
  readQuoteHeader,
  readStoredLines,
  readUserDisplayNames,
} from '../quoteAccess'

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({
    sales: { sales_quote: 'sales:sales_quote', sales_quote_line: 'sales:sales_quote_line', sales_order_line: 'sales:sales_order_line' },
    auth: { user: 'auth:user' },
  }),
}))

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

function resolver(services: Record<string, unknown>) {
  return {
    resolve: (name: string) => {
      if (!(name in services)) throw new Error(`Could not resolve ${name}`)
      return services[name]
    },
  }
}

describe('customerNameFromSnapshot', () => {
  it('prefers the customer display name, then the contact name, and reads JSON strings', () => {
    expect(customerNameFromSnapshot({ customer: { displayName: ' Acme ' }, contact: { firstName: 'Ann' } })).toBe('Acme')
    expect(customerNameFromSnapshot({ contact: { firstName: 'Ann', preferredName: 'Annie', lastName: 'Lee' } })).toBe('Annie Lee')
    expect(customerNameFromSnapshot(JSON.stringify({ contact: { firstName: 'Ann' } }))).toBe('Ann')
    expect(customerNameFromSnapshot('not json')).toBeNull()
    expect(customerNameFromSnapshot(null)).toBeNull()
  })
})

describe('readQuoteHeader', () => {
  it('reads one quote of the selected organization through the query engine', async () => {
    const query = jest.fn(async () => ({
      items: [
        {
          id: 'quote-1',
          organization_id: 'org-1',
          quote_number: 'Q-1',
          status: 'draft',
          currency_code: 'EUR',
          channel_id: null,
          customer_entity_id: 'customer-1',
          customer_snapshot: { customer: { displayName: 'Acme' } },
          updated_at: new Date('2026-11-06T10:00:00.000Z'),
        },
      ],
    }))
    await expect(readQuoteHeader(resolver({ queryEngine: { query } }), 'quote-1', scope)).resolves.toEqual({
      id: 'quote-1',
      organizationId: 'org-1',
      quoteNumber: 'Q-1',
      status: 'draft',
      currencyCode: 'EUR',
      channelId: null,
      customerEntityId: 'customer-1',
      customerName: 'Acme',
      updatedAt: '2026-11-06T10:00:00.000Z',
    })
    expect(query).toHaveBeenCalledWith('sales:sales_quote', expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'org-1' }))
  })

  it('returns null for a quote that is not visible', async () => {
    const query = jest.fn(async () => ({ items: [] }))
    await expect(readQuoteHeader(resolver({ queryEngine: { query } }), 'quote-1', scope)).resolves.toBeNull()
  })
})

describe('assertFeatures', () => {
  function ctx(services: Record<string, unknown>, sub: string | null = 'user-1'): CommandRuntimeContext {
    return {
      container: resolver(services) as unknown as CommandRuntimeContext['container'],
      auth: sub ? ({ sub, tenantId: 'tenant-1', orgId: 'org-1' } as CommandRuntimeContext['auth']) : null,
      organizationScope: null,
      selectedOrganizationId: 'org-1',
      organizationIds: ['org-1'],
    }
  }

  it('passes when the RBAC service grants every feature', async () => {
    const userHasAllFeatures = jest.fn(async () => true)
    await expect(assertFeatures(ctx({ rbacService: { userHasAllFeatures } }), ['a.view', 'b.view'], scope)).resolves.toBe('user-1')
    expect(userHasAllFeatures).toHaveBeenCalledWith('user-1', ['a.view', 'b.view'], scope)
  })

  it('fails closed without a grant, an actor or an RBAC service', async () => {
    const denied = { rbacService: { userHasAllFeatures: jest.fn(async () => false) } }
    await expect(assertFeatures(ctx(denied), ['a.view'], scope)).rejects.toMatchObject({ status: 403, body: { code: 'forbidden' } })
    await expect(assertFeatures(ctx({}), ['a.view'], scope)).rejects.toMatchObject({ status: 403 })
    const granted = { rbacService: { userHasAllFeatures: jest.fn(async () => true) } }
    await expect(assertFeatures(ctx(granted, null), ['a.view'], scope)).rejects.toMatchObject({ status: 403 })
  })
})

describe('readUserDisplayNames', () => {
  it('uses the name, then the email, and skips the query without ids', async () => {
    const query = jest.fn(async () => ({ items: [{ id: 'u-1', name: 'Ann Lee', email: 'ann@example.com' }, { id: 'u-2', name: '', email: 'bob@example.com' }] }))
    const names = await readUserDisplayNames(resolver({ queryEngine: { query } }), ['u-1', 'u-2', 'u-1'], 'tenant-1')
    expect(Object.fromEntries(names)).toEqual({ 'u-1': 'Ann Lee', 'u-2': 'bob@example.com' })
    expect(query).toHaveBeenCalledWith('auth:user', expect.objectContaining({ tenantId: 'tenant-1', filters: { id: { $in: ['u-1', 'u-2'] } } }))
    query.mockClear()
    await readUserDisplayNames(resolver({ queryEngine: { query } }), [], 'tenant-1')
    expect(query).not.toHaveBeenCalled()
  })
})

type LineQuery = { tenantId?: string; organizationId?: string; filters: Record<string, { $eq?: string; $in?: string[] }>; page?: { page?: number; pageSize?: number } }

/** A query engine over `count` lines of one quote that, like the real one, returns 20 rows unless asked for a page size. */
function pagedLineEngine(count: number, carrierIndex: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `line-${String(index).padStart(4, '0')}`,
    quote_id: 'quote-1',
    name: `Line ${index}`,
    configuration: index === carrierIndex ? { productConfigurator: { snapshotId: 'snapshot-1', hash: 'h' } } : null,
    quantity: '1.0000',
    unit_price_net: '10.0000',
  }))
  const query = jest.fn(async (_entity: string, options: LineQuery) => {
    const pageSize = options.page?.pageSize ?? 20
    const page = options.page?.page ?? 1
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length }
  })
  return { query }
}

describe('findLineCarryingSnapshot', () => {
  it.each([
    ['past the default 20 rows', 30, 25],
    ['past the first 100 rows', 150, 140],
  ])('pages through all lines of the quote %s', async (_label, count, carrierIndex) => {
    const engine = pagedLineEngine(count, carrierIndex)
    const line = await findLineCarryingSnapshot(resolver({ queryEngine: engine }), 'quote', 'quote-1', 'snapshot-1', scope)
    expect(line?.id).toBe(`line-${String(carrierIndex).padStart(4, '0')}`)
    const calls = engine.query.mock.calls as unknown as Array<[string, LineQuery]>
    expect(calls.every(([entity, options]) => entity === 'sales:sales_quote_line' && options.page?.pageSize === 100)).toBe(true)
    expect(calls[0][1]).toMatchObject({ tenantId: 'tenant-1', organizationId: 'org-1', filters: { quote_id: { $eq: 'quote-1' } } })
  })

  it('returns null when no line carries the snapshot and reads order lines by order id', async () => {
    const engine = pagedLineEngine(5, -1)
    await expect(findLineCarryingSnapshot(resolver({ queryEngine: engine }), 'order', 'order-1', 'snapshot-1', scope)).resolves.toBeNull()
    const calls = engine.query.mock.calls as unknown as Array<[string, LineQuery]>
    expect(calls[0][0]).toBe('sales:sales_order_line')
    expect(calls[0][1].filters).toEqual({ order_id: { $eq: 'order-1' } })
  })
})

describe('readStoredLines', () => {
  it('reads lines by id in the tenant without narrowing the organization', async () => {
    const query = jest.fn(async () => ({ items: [{ id: 'line-1', configuration: '{"productConfigurator":{"snapshotId":"s-1"}}', unit_price_net: 12.5 }] }))
    const lines = await readStoredLines(resolver({ queryEngine: { query } }), 'quote', ['line-1', 'line-1'], 'tenant-1')
    expect(query).toHaveBeenCalledWith('sales:sales_quote_line', expect.objectContaining({ tenantId: 'tenant-1', filters: { id: { $in: ['line-1'] } } }))
    expect(query.mock.calls[0]).not.toHaveProperty('1.organizationId')
    expect(lines.get('line-1')).toMatchObject({ unitPriceNet: '12.5' })
    expect(readConfigurationMarker(lines.get('line-1')?.configuration)).toMatchObject({ snapshotId: 's-1' })
  })
})
