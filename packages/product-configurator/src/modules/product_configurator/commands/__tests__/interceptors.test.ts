/** @jest-environment node */
import type { AwilixContainer } from 'awilix'
import type { CommandInterceptor, CommandInterceptorContext } from '@open-mercato/shared/lib/commands/command-interceptor'
import { runCommandInterceptorsBefore } from '@open-mercato/shared/lib/commands/command-interceptor-runner'
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSession, ConfigurationSnapshot } from '../../data/entities'
import { markTrustedFinaliseRequest } from '../../lib/lineGuard'
import { interceptors } from '../interceptors'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const LINE_ID = '44444444-4444-4444-8444-444444444444'
const SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555'
const PRODUCT_ID = '66666666-6666-4666-8666-666666666666'
const SESSION_ID = '77777777-7777-4777-8777-777777777777'
const VERSION_ID = '88888888-8888-4888-8888-888888888888'
const MODEL_ID = '99999999-9999-4999-8999-999999999999'
const HASH = 'a'.repeat(64)
const MARKER = { productConfigurator: { snapshotId: SNAPSHOT_ID, modelVersionId: VERSION_ID, hash: HASH, summary: 'Size: Small' } }

const queryMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const reconcileMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key, locale: 'en' }),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({
    sales: { sales_quote: 'sales:sales_quote', sales_quote_line: 'sales:sales_quote_line', sales_order_line: 'sales:sales_order_line' },
    auth: { user: 'auth:user' },
  }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: async () => [{ id: SESSION_ID, organizationId: ORG_ID }],
}))

jest.mock('../../lib/finalise', () => ({
  ...jest.requireActual('../../lib/finalise'),
  reconcileConvertedQuote: (...args: unknown[]) => reconcileMock(...args),
}))

const configuredLineRow = {
  id: LINE_ID,
  quote_id: QUOTE_ID,
  name: 'Pump',
  configuration: MARKER,
  product_id: PRODUCT_ID,
  product_variant_id: null,
  currency_code: 'EUR',
  quantity: '1.0000',
  quantity_unit: 'pc',
  unit_price_net: '1234.5600',
  tax_amount: '283.9500',
  total_net_amount: '1234.5600',
  total_gross_amount: '1518.5100',
}

function context(request: Request | null = null): CommandInterceptorContext {
  const container = {
    resolve: (name: string) => {
      if (name === 'queryEngine') return { query: queryMock }
      if (name === 'em') return { fork: () => ({}) }
      throw new Error(`Could not resolve ${name}`)
    },
  } as unknown as AwilixContainer
  return {
    commandId: '',
    auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID } as CommandInterceptorContext['auth'],
    selectedOrganizationId: ORG_ID,
    container,
    request,
  }
}

async function run(commandId: string, input: unknown, request: Request | null = null, extra: CommandInterceptor[] = []) {
  return runCommandInterceptorsBefore([...extra, ...interceptors], commandId, input, context(request), [])
}

function storedLines(rows: Array<Record<string, unknown>>) {
  queryMock.mockImplementation(async (_entity: string, options: { filters: { id?: { $in?: string[] } } }) => {
    const ids = options.filters.id?.$in ?? []
    return { items: rows.filter((row) => ids.includes(String(row.id))) }
  })
}

function quoteLineUpdate(body: Record<string, unknown>) {
  return { body: { id: LINE_ID, quoteId: QUOTE_ID, organizationId: ORG_ID, tenantId: TENANT_ID, ...body } }
}

function pendingSnapshot(overrides: { quoteLineId?: string | null; sessionStatus?: string; netPrice?: string } = {}) {
  findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === ConfigurationSnapshot) {
      return Object.assign(new ConfigurationSnapshot(), {
        id: SNAPSHOT_ID,
        sessionId: SESSION_ID,
        quoteId: QUOTE_ID,
        quoteLineId: overrides.quoteLineId ?? null,
        modelVersionId: VERSION_ID,
        hash: HASH,
        netPrice: overrides.netPrice ?? '1234.5600',
        currencyCode: 'EUR',
      })
    }
    if (entity === ConfigurationSession) return Object.assign(new ConfigurationSession(), { id: SESSION_ID, status: overrides.sessionStatus ?? 'finalising' })
    if (entity === ConfigurationModelVersion) return Object.assign(new ConfigurationModelVersion(), { id: VERSION_ID, modelId: MODEL_ID })
    if (entity === ConfigurationModel) return Object.assign(new ConfigurationModel(), { id: MODEL_ID, productId: PRODUCT_ID })
    return null
  })
}

const finaliseBody = {
  organizationId: ORG_ID,
  tenantId: TENANT_ID,
  quoteId: QUOTE_ID,
  productId: PRODUCT_ID,
  name: 'Pump',
  description: 'Size: Small',
  quantity: 1,
  currencyCode: 'EUR',
  unitPriceNet: '1234.56',
  priceMode: 'net',
  configuration: MARKER,
}

beforeEach(() => {
  queryMock.mockReset()
  findOneWithDecryptionMock.mockReset()
  reconcileMock.mockReset()
  storedLines([configuredLineRow, { ...configuredLineRow, id: 'plain-line', configuration: null }])
})

describe('configured quote line guard', () => {
  it('runs last and without features, so no user is exempt', () => {
    for (const interceptor of interceptors) {
      expect(interceptor.priority).toBe(1000)
      expect(interceptor.features).toBeUndefined()
    }
  })

  it.each([
    ['net price', { unitPriceNet: '999' }, 'unitPriceNet'],
    ['quantity', { quantity: 2 }, 'quantity'],
    ['unit', { quantityUnit: 'm' }, 'quantityUnit'],
    ['product', { productId: '00000000-0000-4000-8000-000000000000' }, 'productId'],
    ['variant', { productVariantId: '00000000-0000-4000-8000-000000000000' }, 'productVariantId'],
    ['currency', { currencyCode: 'USD' }, 'currencyCode'],
    ['marker removal', { configuration: {} }, 'configuration'],
    ['marker null', { configuration: null }, 'configuration'],
    ['marker change', { configuration: { productConfigurator: { ...MARKER.productConfigurator, hash: 'b'.repeat(64) } } }, 'configuration'],
    ['tax amount', { taxAmount: 1 }, 'taxAmount'],
    ['total gross', { totalGrossAmount: 2000 }, 'totalGrossAmount'],
    ['total net', { totalNetAmount: 1 }, 'totalNetAmount'],
  ])('rejects a %s change with 409 configured_line_locked', async (_label, change, field) => {
    const outcome = await run('sales.quotes.lines.upsert', quoteLineUpdate(change))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatchObject({ status: 409, body: { code: 'configured_line_locked', fields: [field] } })
  })

  it('lets name, comment, discount and tax changes through, and the same configured values resent as floats', async () => {
    const outcome = await run(
      'sales.quotes.lines.upsert',
      quoteLineUpdate({
        name: 'Pump for site B',
        comment: 'Deliver in May',
        discountPercent: 5,
        discountAmount: 0,
        taxRateId: '00000000-0000-4000-8000-000000000001',
        taxRate: 21,
        quantity: 1,
        unitPriceNet: 1234.56,
        productId: PRODUCT_ID,
        currencyCode: 'EUR',
        quantityUnit: 'pc',
        totalGrossAmount: '1518.51',
        configuration: { productConfigurator: { summary: 'Size: Small', hash: HASH, modelVersionId: VERSION_ID, snapshotId: SNAPSHOT_ID } },
      }),
    )
    expect(outcome.ok).toBe(true)
  })

  it('judges the final input, so an earlier interceptor cannot slip a price change past it', async () => {
    const earlier: CommandInterceptor = {
      id: 'test.rewrite-price',
      targetCommand: 'sales.quotes.lines.upsert',
      priority: 10,
      async beforeExecute(input) {
        const body = (input as { body: Record<string, unknown> }).body
        return { modifiedInput: { body: { ...body, unitPriceNet: '1.00' } } }
      },
    }
    const outcome = await run('sales.quotes.lines.upsert', quoteLineUpdate({ name: 'Renamed' }), null, [earlier])
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatchObject({ status: 409, body: { code: 'configured_line_locked', fields: ['unitPriceNet'] } })
  })

  it('reads the stored line fresh in the tenant on every update', async () => {
    await run('sales.quotes.lines.upsert', quoteLineUpdate({ name: 'x' }))
    expect(queryMock).toHaveBeenCalledWith('sales:sales_quote_line', expect.objectContaining({ tenantId: TENANT_ID, filters: { id: { $in: [LINE_ID] } } }))
  })

  it('without a trusted tenant, finds the line by id in any tenant and judges it in its own tenant', async () => {
    const OTHER_TENANT = '00000000-0000-4000-8000-0000000000cc'
    queryMock.mockImplementation(async (_entity: string, options: { tenantId: string; omitAutomaticTenantOrgScope?: boolean; filters: { id: { $in: string[] } } }) => {
      if (options.omitAutomaticTenantOrgScope) return { items: [{ id: LINE_ID, tenant_id: OTHER_TENANT }] }
      return { items: options.tenantId === OTHER_TENANT ? [configuredLineRow] : [] }
    })
    const untrusted = { ...context(), auth: null, organizationScope: null }
    const locked = await runCommandInterceptorsBefore(interceptors, 'sales.quotes.lines.upsert', quoteLineUpdate({ unitPriceNet: '1' }), untrusted, [])
    expect(locked.error).toMatchObject({ status: 409, body: { code: 'configured_line_locked', fields: ['unitPriceNet'] } })
    expect(queryMock).toHaveBeenCalledWith(
      'sales:sales_quote_line',
      expect.objectContaining({ omitAutomaticTenantOrgScope: true, decryptEncryptedFields: false, fields: ['id', 'tenant_id'] }),
    )
    expect(queryMock).toHaveBeenCalledWith('sales:sales_quote_line', expect.objectContaining({ tenantId: OTHER_TENANT, filters: { id: { $in: [LINE_ID] } } }))
    await expect(
      runCommandInterceptorsBefore(interceptors, 'sales.quotes.lines.upsert', quoteLineUpdate({ name: 'Renamed' }), untrusted, []),
    ).resolves.toMatchObject({ ok: true })
  })

  it('without a trusted tenant, still refuses a forged marker and a line write naming no tenant at all', async () => {
    const untrusted = { ...context(), auth: null, organizationScope: null }
    pendingSnapshot()
    const forged = await runCommandInterceptorsBefore(
      interceptors,
      'sales.quotes.lines.upsert',
      { body: finaliseBody },
      { ...untrusted, request: markTrustedFinaliseRequest(new Request('http://product-configurator.internal/finalise')) },
      [],
    )
    expect(forged.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
    const { tenantId: _tenantId, ...withoutTenant } = quoteLineUpdate({ name: 'x' }).body
    const unverified = await runCommandInterceptorsBefore(interceptors, 'sales.quotes.lines.upsert', { body: withoutTenant }, untrusted, [])
    expect(unverified.error).toMatchObject({ status: 403, body: { code: 'configured_line_unverified' } })
    await expect(
      runCommandInterceptorsBefore(interceptors, 'sales.quotes.lines.upsert', { body: { quoteId: QUOTE_ID, unitPriceNet: '5' } }, untrusted, []),
    ).resolves.toMatchObject({ ok: true })
  })

  it('uses the tenant of the resolved organization scope when auth carries none', async () => {
    const scoped = { ...context(), auth: null, organizationScope: { tenantId: TENANT_ID } as CommandInterceptorContext['organizationScope'] }
    await runCommandInterceptorsBefore(interceptors, 'sales.quotes.lines.upsert', quoteLineUpdate({ name: 'x' }), scoped, [])
    expect(queryMock).toHaveBeenCalledWith('sales:sales_quote_line', expect.objectContaining({ tenantId: TENANT_ID }))
  })

  it('compares amounts as exact decimals at any scale, so any extra digit is a change', async () => {
    storedLines([{ ...configuredLineRow, unit_price_net: '12345678901234.5678' }])
    await expect(run('sales.quotes.lines.upsert', quoteLineUpdate({ unitPriceNet: '12345678901234.5678' }))).resolves.toMatchObject({ ok: true })
    const changed = await run('sales.quotes.lines.upsert', quoteLineUpdate({ unitPriceNet: '12345678901234.5679' }))
    expect(changed.error).toMatchObject({ status: 409, body: { fields: ['unitPriceNet'] } })
    storedLines([configuredLineRow])
    await expect(run('sales.quotes.lines.upsert', quoteLineUpdate({ quantity: '1', unitPriceNet: '1234.56' }))).resolves.toMatchObject({ ok: true })
    await expect(run('sales.quotes.lines.upsert', quoteLineUpdate({ quantity: '1e0', unitPriceNet: 1234.56 }))).resolves.toMatchObject({ ok: true })
    for (const quantity of ['1.00004', 1.00004, '1.00000000001']) {
      const sub = await run('sales.quotes.lines.upsert', quoteLineUpdate({ quantity }))
      expect(sub.error).toMatchObject({ status: 409, body: { fields: ['quantity'] } })
    }
    storedLines([{ ...configuredLineRow, unit_price_net: '0.3000' }])
    const floatNoise = await run('sales.quotes.lines.upsert', quoteLineUpdate({ unitPriceNet: 0.1 + 0.2 }))
    expect(floatNoise.error).toMatchObject({ status: 409, body: { fields: ['unitPriceNet'] } })
    for (const unitPriceNet of ['abc', '1e100000000']) {
      const invalid = await run('sales.quotes.lines.upsert', quoteLineUpdate({ unitPriceNet }))
      expect(invalid.error).toMatchObject({ status: 409 })
    }
  })

  it('rejects a marker added to a plain line with 422 configured_line_forged', async () => {
    const outcome = await run('sales.quotes.lines.upsert', { body: { id: 'plain-line', quoteId: QUOTE_ID, configuration: MARKER } })
    expect(outcome.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
  })

  it('leaves plain lines alone', async () => {
    await expect(run('sales.quotes.lines.upsert', { body: { id: 'plain-line', unitPriceNet: '5' } })).resolves.toMatchObject({ ok: true })
    await expect(run('sales.quotes.lines.upsert', { body: { quoteId: QUOTE_ID, unitPriceNet: '5' } })).resolves.toMatchObject({ ok: true })
  })

  it('rejects a marker on an insert from any request finalise did not create, even for a real pending snapshot', async () => {
    pendingSnapshot()
    const forged = await run('sales.quotes.lines.upsert', { body: finaliseBody }, new Request('http://localhost/api/sales/quote-lines'))
    expect(forged.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
    const withId = await run(
      'sales.quotes.lines.upsert',
      { body: { ...finaliseBody, id: '00000000-0000-4000-8000-0000000000aa' } },
      markTrustedFinaliseRequest(new Request('http://product-configurator.internal/finalise')),
    )
    expect(withId.error).toMatchObject({ status: 422 })
  })

  it('allows the trusted finalise insert that matches its pending snapshot', async () => {
    pendingSnapshot()
    const outcome = await run('sales.quotes.lines.upsert', { body: finaliseBody }, markTrustedFinaliseRequest(new Request('http://product-configurator.internal/finalise')))
    expect(outcome.ok).toBe(true)
  })

  it.each([
    ['a different net price', { body: { ...finaliseBody, unitPriceNet: '1.00' } }, {}],
    ['another quote', { body: { ...finaliseBody, quoteId: '00000000-0000-4000-8000-0000000000bb' } }, {}],
    ['quantity 2', { body: { ...finaliseBody, quantity: 2 } }, {}],
    ['quantity 1.00004', { body: { ...finaliseBody, quantity: '1.00004' } }, {}],
    ['a linked snapshot', { body: finaliseBody }, { quoteLineId: LINE_ID }],
    ['a session that is not finalising', { body: finaliseBody }, { sessionStatus: 'open' }],
  ])('refuses a trusted insert with %s', async (_label, input, snapshot) => {
    pendingSnapshot(snapshot)
    const outcome = await run('sales.quotes.lines.upsert', input, markTrustedFinaliseRequest(new Request('http://product-configurator.internal/finalise')))
    expect(outcome.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
  })
})

describe('configured order line guard', () => {
  beforeEach(() => {
    storedLines([{ ...configuredLineRow, quote_id: undefined, order_id: 'order-1' }])
  })

  it('protects a converted configured line on the order', async () => {
    const outcome = await run('sales.orders.lines.upsert', { body: { id: LINE_ID, orderId: 'order-1', unitPriceNet: '1' } })
    expect(outcome.error).toMatchObject({ status: 409, body: { code: 'configured_line_locked' } })
    expect(queryMock).toHaveBeenCalledWith('sales:sales_order_line', expect.anything())
  })

  it('never accepts a marker on an order line insert, trusted or not', async () => {
    pendingSnapshot()
    const outcome = await run(
      'sales.orders.lines.upsert',
      { body: { ...finaliseBody, orderId: 'order-1' } },
      markTrustedFinaliseRequest(new Request('http://product-configurator.internal/finalise')),
    )
    expect(outcome.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
  })

  it('checks every line of a bulk upsert', async () => {
    const outcome = await run('sales.orders.lines.upsert_many', {
      body: { orderId: 'order-1', lines: [{ name: 'New plain line' }, { id: LINE_ID, quantity: 3 }] },
    })
    expect(outcome.error).toMatchObject({ status: 409, body: { fields: ['quantity'] } })
  })
})

describe('inline lines on document create', () => {
  it.each(['sales.quotes.create', 'sales.orders.create'])('%s rejects inline lines carrying the marker', async (commandId) => {
    const outcome = await run(commandId, { currencyCode: 'EUR', lines: [{ name: 'Plain' }, { ...finaliseBody }] })
    expect(outcome.error).toMatchObject({ status: 422, body: { code: 'configured_line_forged' } })
    await expect(run(commandId, { currencyCode: 'EUR', lines: [{ name: 'Plain', configuration: { other: true } }] })).resolves.toMatchObject({ ok: true })
  })
})

describe('conversion cleanup', () => {
  const cleanup = interceptors.find((interceptor) => interceptor.targetCommand === 'sales.quotes.convert_to_order')!

  it('reconciles the sessions of a converted quote against the order from the command result', async () => {
    queryMock.mockResolvedValue({ items: [] })
    reconcileMock.mockResolvedValue({ finalised: [], cancelled: [SESSION_ID], skipped: [] })
    await cleanup.afterExecute!({ quoteId: QUOTE_ID }, { orderId: 'order-9' }, context())
    expect(reconcileMock).toHaveBeenCalledWith(expect.anything(), { quoteId: QUOTE_ID, orderId: 'order-9' })
  })

  it('does nothing while the quote is still readable (conversion inside an uncommitted caller transaction)', async () => {
    queryMock.mockResolvedValue({ items: [{ id: QUOTE_ID, currency_code: 'EUR' }] })
    await cleanup.afterExecute!({ quoteId: QUOTE_ID }, { orderId: QUOTE_ID }, context())
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('never throws into the conversion', async () => {
    queryMock.mockResolvedValue({ items: [] })
    reconcileMock.mockRejectedValue(new Error('boom'))
    await expect(cleanup.afterExecute!({ quoteId: QUOTE_ID }, { orderId: QUOTE_ID }, context())).resolves.toBeUndefined()
  })
})
