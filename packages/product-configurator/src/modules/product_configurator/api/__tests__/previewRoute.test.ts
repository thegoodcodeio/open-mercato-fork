/** @jest-environment node */
import { ConfigurationModel } from '../../data/entities'
import { ConfiguratorEvaluationError } from '../../lib/evaluator/errors'
import { build, referenceInput } from '../../lib/__tests__/fixtures'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const MODEL_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '77777777-7777-4777-8777-777777777777'
const CHANNEL_ID = '88888888-8888-4888-8888-888888888888'
const CUSTOMER_ID = '99999999-9999-4999-8999-999999999999'

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const runRouteMutationGuardsMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const commandExecuteMock = jest.fn()
const evaluateConfigurationMock = jest.fn()
const queryMock = jest.fn()
const em = { fork: () => em }

const container = {
  resolve: (token: string) => {
    if (token === 'em') return em
    if (token === 'commandBus') return { execute: commandExecuteMock }
    if (token === 'queryEngine') return { query: queryMock }
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

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => runRouteMutationGuardsMock(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({ sales: { sales_channel: 'sales:sales_channel' }, customers: { customer_entity: 'customers:customer_entity' } }),
}))

jest.mock('../../lib/evaluation', () => ({
  evaluateConfiguration: (...args: unknown[]) => evaluateConfigurationMock(...args),
}))

import { POST as preview, metadata } from '../models/preview/route'

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/product_configurator/models/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function storedModel(draftDefinition: unknown = referenceInput()): ConfigurationModel {
  return Object.assign(new ConfigurationModel(), {
    id: MODEL_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    title: 'Pump',
    currencyCode: 'EUR',
    draftDefinition,
    draftHash: 'd'.repeat(64),
  })
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    forced: [],
    errors: [],
    warnings: [],
    surcharges: [],
    netPrice: '10.00',
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  getAuthFromRequestMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID })
  findOneWithDecryptionMock.mockResolvedValue(storedModel())
  evaluateConfigurationMock.mockResolvedValue(result())
  queryMock.mockImplementation(async (_entityId: string, options: { filters: { id: { $eq: string } } }) => ({
    items: [{ id: options.filters.id.$eq }],
  }))
})

describe('POST /models/preview', () => {
  it('needs model manage and catalog view, because it returns catalog prices', () => {
    expect(metadata.POST.requireFeatures).toEqual(['product_configurator.models.manage', 'catalog.products.view'])
  })

  it('evaluates the saved draft for the reference context without guards, commands or a session', async () => {
    const response = await preview(postRequest({ id: MODEL_ID, selections: { motor: 'heavy' } }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ evaluation: result(), trace: { firedRules: [] }, referenceContext: true })
    const call = evaluateConfigurationMock.mock.calls[0][0]
    expect(call.definition).toEqual(build())
    expect(call.modelVersion).toEqual({ id: MODEL_ID, hash: 'd'.repeat(64) })
    expect(call.selections).toEqual({ motor: 'heavy' })
    expect(call.pricing).toMatchObject({ channelId: null, customerId: null, scope: { tenantId: TENANT_ID, organizationId: ORG_ID } })
    expect(Math.abs(call.pricing.at.getTime() - Date.now())).toBeLessThan(5000)
    expect(findOneWithDecryptionMock.mock.calls[0][2]).toEqual({ id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID, deletedAt: null })
    expect(runRouteMutationGuardsMock).not.toHaveBeenCalled()
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })

  it('prices for the chosen channel, customer and date and lists the rules that fired', async () => {
    const definition = build((input) => {
      input.rules = [
        { id: 'warn-1', label: 'Long pipe', effect: 'warning', when: [], messageTemplate: 'Long', featureKeys: [], order: 2 },
        { id: 'force-1', effect: 'force', when: [], action: { kind: 'set', featureKey: 'cover', value: true }, messageTemplate: '', featureKeys: [], order: 1 },
        { id: 'quiet', effect: 'error', when: [], messageTemplate: 'Never', featureKeys: [], order: 3 },
      ]
    })
    findOneWithDecryptionMock.mockResolvedValue(storedModel(definition))
    evaluateConfigurationMock.mockResolvedValue(
      result({
        forced: [{ featureKey: 'cover', ruleId: 'force-1', from: false, to: true }],
        warnings: [{ ruleId: 'warn-1', params: {} }],
      }),
    )
    const response = await preview(
      postRequest({ id: MODEL_ID, context: { channelId: CHANNEL_ID, customerId: CUSTOMER_ID, date: '2026-10-27' } }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.referenceContext).toBe(false)
    expect(body.trace.firedRules).toEqual([
      { ruleId: 'force-1', label: null, effect: 'force' },
      { ruleId: 'warn-1', label: 'Long pipe', effect: 'warning' },
    ])
    const call = evaluateConfigurationMock.mock.calls[0][0]
    expect(call.selections).toEqual({})
    expect(call.pricing).toMatchObject({ channelId: CHANNEL_ID, customerId: CUSTOMER_ID })
    expect(call.pricing.at.toISOString()).toBe('2026-10-27T00:00:00.000Z')
    expect(queryMock.mock.calls.map(([entityId, options]) => [entityId, options.tenantId, options.organizationId])).toEqual([
      ['sales:sales_channel', TENANT_ID, ORG_ID],
      ['customers:customer_entity', TENANT_ID, ORG_ID],
    ])
  })

  it('answers 404 for a customer or channel outside the selected organization and prices nothing', async () => {
    queryMock.mockImplementation(async (entityId: string, options: { filters: { id: { $eq: string } } }) => ({
      items: entityId === 'customers:customer_entity' ? [] : [{ id: options.filters.id.$eq }],
    }))
    const customer = await preview(postRequest({ id: MODEL_ID, context: { customerId: CUSTOMER_ID } }))
    expect(customer.status).toBe(404)
    await expect(customer.json()).resolves.toMatchObject({ code: 'customer_not_found' })

    queryMock.mockResolvedValue({ items: [] })
    const channel = await preview(postRequest({ id: MODEL_ID, context: { channelId: CHANNEL_ID } }))
    expect(channel.status).toBe(404)
    await expect(channel.json()).resolves.toMatchObject({ code: 'channel_not_found' })
    expect(evaluateConfigurationMock).not.toHaveBeenCalled()
  })

  it('maps a thrown evaluation error to 422 with its code and params', async () => {
    evaluateConfigurationMock.mockRejectedValue(new ConfiguratorEvaluationError('price_missing', { skus: ['PIPE-M'], channelId: CHANNEL_ID }))
    const response = await preview(postRequest({ id: MODEL_ID, context: { channelId: CHANNEL_ID } }))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'price_missing', params: { skus: ['PIPE-M'], channelId: CHANNEL_ID } })
  })

  it('answers 422 invalid_definition when the saved draft does not parse', async () => {
    findOneWithDecryptionMock.mockResolvedValue(storedModel({ schemaVersion: 1 }))
    const response = await preview(postRequest({ id: MODEL_ID }))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_definition' })
    expect(evaluateConfigurationMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a model outside the selected organization', async () => {
    findOneWithDecryptionMock.mockResolvedValue(null)
    const response = await preview(postRequest({ id: MODEL_ID }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'model_not_found' })
  })

  it('rejects an unknown context field, a bad date and all organizations', async () => {
    expect((await preview(postRequest({ id: MODEL_ID, context: { quoteId: CHANNEL_ID } }))).status).toBe(400)
    expect((await preview(postRequest({ id: MODEL_ID, context: { date: '27.10.2026' } }))).status).toBe(400)
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT_ID })
    const response = await preview(postRequest({ id: MODEL_ID }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'organization_scope_required' })
    expect(evaluateConfigurationMock).not.toHaveBeenCalled()
  })

  it('answers 413 for a request over 64 KB', async () => {
    const response = await preview(postRequest({ id: MODEL_ID, selections: { motor: 'x'.repeat(70 * 1024) } }))
    expect(response.status).toBe(413)
  })
})
