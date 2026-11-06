/** @jest-environment node */
import { CommandBus } from '@open-mercato/shared/lib/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import type { LineUpdateInput } from '../../data/validators'
import { changedProtectedFields } from '../../lib/lineGuard'
import type { StoredLine } from '../../lib/quoteAccess'
import { buildLineUpsertBody, discountFields, grossFromNet, type LineUpdateResult } from '../lines'
import '../lines'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const LINE_ID = '44444444-4444-4444-8444-444444444444'
const PRODUCT_ID = '55555555-5555-4555-8555-555555555555'
const TAX_RATE_ID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '77777777-7777-4777-8777-777777777777'

type Row = Record<string, unknown>

const tables: Record<string, Row[]> = {}
const queryMock = jest.fn(async (entity: string, options: { filters: Record<string, { $eq?: string; $in?: string[] }> }) => ({
  items: (tables[entity] ?? []).filter((row) =>
    Object.entries(options.filters).every(([column, filter]) =>
      filter.$eq !== undefined ? row[column] === filter.$eq : (filter.$in ?? []).includes(String(row[column])),
    ),
  ),
}))
const executeMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({
    sales: { sales_quote: 'sales:sales_quote', sales_quote_line: 'sales:sales_quote_line', sales_tax_rate: 'sales:sales_tax_rate' },
  }),
}))

const marker = { productConfigurator: { snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', modelVersionId: 'v', hash: 'h', summary: 's' } }

function storedLineRow(overrides: Row = {}): Row {
  return {
    id: LINE_ID,
    quote_id: QUOTE_ID,
    name: 'Pump',
    configuration: marker,
    product_id: PRODUCT_ID,
    product_variant_id: null,
    currency_code: 'EUR',
    quantity: '1.0000',
    quantity_unit: null,
    unit_price_net: '1234.5600',
    tax_amount: '283.9500',
    total_net_amount: '1234.5600',
    total_gross_amount: '1518.5100',
    ...overrides,
  }
}

function storedLine(): StoredLine {
  return {
    id: LINE_ID,
    parentId: QUOTE_ID,
    name: 'Pump',
    configuration: marker,
    productId: PRODUCT_ID,
    productVariantId: null,
    currencyCode: 'EUR',
    quantity: '1.0000',
    quantityUnit: null,
    unitPriceNet: '1234.5600',
    taxAmount: '283.9500',
    totalNetAmount: '1234.5600',
    totalGrossAmount: '1518.5100',
  }
}

function makeCtx(request?: Request, services: Record<string, unknown> = {}): CommandRuntimeContext {
  return {
    container: {
      resolve: (token: string) => {
        if (token in services) return services[token]
        if (token === 'queryEngine') return { query: queryMock }
        if (token === 'rbacService') return { userHasAllFeatures: userHasAllFeaturesMock }
        if (token === 'commandBus') return { execute: executeMock }
        throw new Error(`Could not resolve ${token}`)
      },
    } as unknown as CommandRuntimeContext['container'],
    auth: { sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID } as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: ORG_ID,
    organizationIds: [ORG_ID],
    request,
  }
}

function handler(): CommandHandler<LineUpdateInput, LineUpdateResult> {
  const registered = commandRegistry.get('product_configurator.lines.update')
  if (!registered) throw new Error('product_configurator.lines.update not registered')
  return registered as CommandHandler<LineUpdateInput, LineUpdateResult>
}

const scope = { tenantId: TENANT_ID, organizationId: ORG_ID }

beforeEach(() => {
  jest.clearAllMocks()
  tables['sales:sales_quote'] = [{ id: QUOTE_ID, currency_code: 'EUR', updated_at: '2026-11-06T12:00:00.000Z' }]
  tables['sales:sales_quote_line'] = [storedLineRow()]
  tables['sales:sales_tax_rate'] = [{ id: TAX_RATE_ID, rate: '8.0000' }]
  userHasAllFeaturesMock.mockResolvedValue(true)
  executeMock.mockResolvedValue({ result: { quoteId: QUOTE_ID, lineId: LINE_ID } })
})

describe('discountFields', () => {
  it('clears the other discount field for each mode', () => {
    expect(discountFields({ mode: 'percent', value: 5 })).toEqual({ discountPercent: 5, discountAmount: 0, discountAmountBasis: 'line' })
    expect(discountFields({ mode: 'amount', value: 1000 })).toEqual({ discountAmount: 1000, discountAmountBasis: 'line', discountPercent: 0 })
    expect(discountFields({ mode: 'none' })).toEqual({ discountPercent: 0, discountAmount: 0, discountAmountBasis: 'line' })
  })
})

describe('grossFromNet', () => {
  it('derives the unit gross half-up at four decimals', () => {
    expect(grossFromNet('1234.5600', '23')).toBe('1518.5088')
    expect(grossFromNet('10', '0')).toBe('10.0000')
    expect(grossFromNet('0.0001', '50')).toBe('0.0002')
  })
})

describe('buildLineUpsertBody', () => {
  it('re-sends the configured inputs unchanged so the configured line guard sees no protected change', () => {
    const body = buildLineUpsertBody(
      { quoteId: QUOTE_ID, lineId: LINE_ID, name: 'Pump, blue', comment: null, discount: { mode: 'amount', value: 100 } },
      storedLine(),
      scope,
      '8.0000',
    )
    expect(body).toEqual({
      id: LINE_ID,
      quoteId: QUOTE_ID,
      organizationId: ORG_ID,
      tenantId: TENANT_ID,
      quantity: '1.0000',
      productId: PRODUCT_ID,
      currencyCode: 'EUR',
      unitPriceNet: '1234.5600',
      name: 'Pump, blue',
      comment: '',
      discountAmount: 100,
      discountAmountBasis: 'line',
      discountPercent: 0,
      taxRate: '8.0000',
      unitPriceGross: '1333.3248',
    })
    expect(changedProtectedFields(body, storedLine())).toEqual([])
  })

  it('leaves out what the rep did not change', () => {
    expect(buildLineUpsertBody({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'Pump' }, storedLine(), scope, null)).not.toHaveProperty('taxRate')
  })
})

describe('product_configurator.lines.update', () => {
  it('dispatches the sales line upsert with the caller context and answers the new quote updatedAt', async () => {
    const request = new Request('http://localhost/api/product_configurator/lines/update', { method: 'POST' })
    executeMock.mockImplementation(async () => {
      tables['sales:sales_quote'] = [{ id: QUOTE_ID, currency_code: 'EUR', updated_at: '2026-11-06T12:05:00.000Z' }]
      return { result: { quoteId: QUOTE_ID, lineId: LINE_ID } }
    })
    const ctx = makeCtx(request)

    const result = await handler().execute(
      { quoteId: QUOTE_ID, lineId: LINE_ID, discount: { mode: 'percent', value: 5 }, taxRateId: TAX_RATE_ID },
      ctx,
    )

    expect(result).toEqual({ lineId: LINE_ID, quoteId: QUOTE_ID, updatedAt: '2026-11-06T12:05:00.000Z' })
    expect(executeMock).toHaveBeenCalledWith('sales.quotes.lines.upsert', {
      input: {
        body: expect.objectContaining({
          id: LINE_ID,
          quoteId: QUOTE_ID,
          discountPercent: 5,
          discountAmount: 0,
          taxRate: '8.0000',
          taxRateId: TAX_RATE_ID,
          unitPriceNet: '1234.5600',
          quantity: '1.0000',
        }),
      },
      ctx,
    })
    expect(executeMock.mock.calls[0][1].ctx.request).toBe(request)
    expect(userHasAllFeaturesMock).toHaveBeenCalledWith(USER_ID, ['product_configurator.sessions.manage', 'sales.quotes.manage'], scope)
  })

  it('removes the tax rate with taxRateId null', async () => {
    await handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, taxRateId: null }, makeCtx())
    const body = executeMock.mock.calls[0][1].input.body as Record<string, unknown>
    expect(body).toMatchObject({ taxRate: '0', unitPriceGross: '1234.5600' })
    expect(body).not.toHaveProperty('taxRateId')
  })

  it('refuses a plain line, a line of another quote, an unknown tax rate and a quote that is gone', async () => {
    tables['sales:sales_quote_line'] = [storedLineRow({ configuration: null })]
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' }, makeCtx())).rejects.toMatchObject({
      status: 422,
      body: expect.objectContaining({ code: 'not_a_configured_line' }),
    })

    tables['sales:sales_quote_line'] = [storedLineRow({ quote_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' }, makeCtx())).rejects.toMatchObject({
      status: 404,
      body: expect.objectContaining({ code: 'line_not_found' }),
    })

    tables['sales:sales_quote_line'] = [storedLineRow()]
    tables['sales:sales_tax_rate'] = []
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, taxRateId: TAX_RATE_ID }, makeCtx())).rejects.toMatchObject({
      status: 404,
      body: expect.objectContaining({ code: 'tax_rate_not_found' }),
    })

    tables['sales:sales_quote'] = []
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' }, makeCtx())).rejects.toMatchObject({
      status: 404,
      body: expect.objectContaining({ code: 'quote_not_found' }),
    })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('needs quote edit rights and something to change', async () => {
    userHasAllFeaturesMock.mockResolvedValue(false)
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' }, makeCtx())).rejects.toMatchObject({ status: 403 })
    userHasAllFeaturesMock.mockResolvedValue(true)
    await expect(handler().execute({ quoteId: QUOTE_ID, lineId: LINE_ID }, makeCtx())).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'invalid_request' }),
    })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('logs the line before and after the edit in one shape, so a name-only edit records only the name change', async () => {
    tables['sales:sales_quote_line'] = [
      storedLineRow({ comment: 'Old note', discount_percent: '5.0000', discount_amount: '0.0000', tax_rate: '23.0000' }),
    ]
    executeMock.mockImplementation(async () => {
      tables['sales:sales_quote_line'] = [
        storedLineRow({ name: 'Pump, blue', comment: 'Old note', discount_percent: '5.0000', discount_amount: '0.0000', tax_rate: '23.0000' }),
      ]
      return { result: { quoteId: QUOTE_ID, lineId: LINE_ID } }
    })
    const logMock = jest.fn(async (payload: Record<string, unknown>) => payload)

    await new CommandBus().execute('product_configurator.lines.update', {
      input: { quoteId: QUOTE_ID, lineId: LINE_ID, name: 'Pump, blue' },
      ctx: makeCtx(undefined, { actionLogService: { log: logMock } }),
    })

    expect(logMock).toHaveBeenCalledTimes(1)
    const entry = logMock.mock.calls[0][0]
    expect(entry).toMatchObject({
      resourceKind: 'product_configurator.line',
      resourceId: LINE_ID,
      parentResourceKind: 'sales.quote',
      parentResourceId: QUOTE_ID,
      snapshotBefore: { lineId: LINE_ID, quoteId: QUOTE_ID, name: 'Pump', comment: 'Old note', discountPercent: '5.0000', discountAmount: '0.0000', taxRate: '23.0000' },
      snapshotAfter: { lineId: LINE_ID, quoteId: QUOTE_ID, name: 'Pump, blue', comment: 'Old note', discountPercent: '5.0000', discountAmount: '0.0000', taxRate: '23.0000' },
    })
    expect(entry.changes).toEqual({ name: { from: 'Pump', to: 'Pump, blue' } })
    expect(handler().isUndoable).toBe(false)
  })

  it('keeps no before snapshot for a line of another quote or an invalid request', async () => {
    tables['sales:sales_quote_line'] = [storedLineRow({ quote_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]
    expect(await handler().prepare?.({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' }, makeCtx())).toBeNull()
    expect(await handler().prepare?.({ quoteId: QUOTE_ID, lineId: LINE_ID }, makeCtx())).toBeNull()
  })
})
