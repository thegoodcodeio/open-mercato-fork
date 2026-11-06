/** @jest-environment node */
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '44444444-4444-4444-8444-444444444444'
const LINE_ID = '55555555-5555-4555-8555-555555555555'
const USER_ID = '77777777-7777-4777-8777-777777777777'

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const runRouteMutationGuardsMock = jest.fn()
const commandExecuteMock = jest.fn()

const container = {
  resolve: (token: string) => (token === 'commandBus' ? { execute: commandExecuteMock } : undefined),
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

import { POST, metadata } from '../lines/update/route'

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/product_configurator/lines/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  getAuthFromRequestMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID })
  runRouteMutationGuardsMock.mockResolvedValue({ ok: true, modifiedPayload: null, runAfterSuccess: jest.fn(async () => undefined) })
  commandExecuteMock.mockResolvedValue({ result: { lineId: LINE_ID, quoteId: QUOTE_ID, updatedAt: '2026-11-06T12:05:00.000Z' } })
})

describe('POST /lines/update', () => {
  it('needs configurator sessions and quote edit features', () => {
    expect(metadata.POST.requireFeatures).toEqual(['product_configurator.sessions.manage', 'sales.quotes.manage'])
  })

  it('asks the mutation guards about the quote and answers the line id and the new quote updatedAt', async () => {
    const response = await post({ quoteId: QUOTE_ID, lineId: LINE_ID, discount: { mode: 'amount', value: 100 } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ lineId: LINE_ID, updatedAt: '2026-11-06T12:05:00.000Z' })
    expect(runRouteMutationGuardsMock.mock.calls[0][0].input).toMatchObject({ resourceKind: 'sales.quote', resourceId: QUOTE_ID, operation: 'update' })
    expect(commandExecuteMock).toHaveBeenCalledWith('product_configurator.lines.update', {
      input: { quoteId: QUOTE_ID, lineId: LINE_ID, discount: { mode: 'amount', value: 100 } },
      ctx: expect.objectContaining({ selectedOrganizationId: ORG_ID }),
    })
  })

  it.each([
    [{ quoteId: QUOTE_ID, lineId: LINE_ID }],
    [{ quoteId: QUOTE_ID, lineId: LINE_ID, discount: { mode: 'percent', value: 120 } }],
    [{ quoteId: QUOTE_ID, lineId: LINE_ID, discount: { mode: 'amount' } }],
    [{ quoteId: QUOTE_ID, lineId: LINE_ID, name: '   ' }],
  ])('answers 400 for %j without running the command', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })

  it('passes command errors through, such as a plain line or a lock conflict', async () => {
    commandExecuteMock.mockRejectedValueOnce(new CrudHttpError(422, { error: 'Not configured', code: 'not_a_configured_line' }))
    const refused = await post({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' })
    expect(refused.status).toBe(422)
    await expect(refused.json()).resolves.toMatchObject({ code: 'not_a_configured_line' })

    commandExecuteMock.mockRejectedValueOnce(new CrudHttpError(409, { error: 'Conflict', code: 'optimistic_lock_conflict' }))
    expect((await post({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'x' })).status).toBe(409)
  })
})
