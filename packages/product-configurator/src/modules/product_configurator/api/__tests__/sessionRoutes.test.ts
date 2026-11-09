/** @jest-environment node */
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSession, ConfigurationSnapshot } from '../../data/entities'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const QUOTE_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '55555555-5555-4555-8555-555555555555'
const MODEL_ID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '77777777-7777-4777-8777-777777777777'

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const runRouteMutationGuardsMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()
const commandExecuteMock = jest.fn()
const queryMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()
const em = { fork: () => em }

const container = {
  resolve: (token: string) => {
    if (token === 'em') return em
    if (token === 'commandBus') return { execute: commandExecuteMock }
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

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => runRouteMutationGuardsMock(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({ sales: { sales_quote: 'sales:sales_quote', sales_quote_line: 'sales:sales_quote_line' }, auth: { user: 'auth:user' } }),
}))

import { GET as getSessions, POST as openSession, metadata as sessionsMetadata } from '../sessions/route'
import { POST as evaluateSession, metadata as evaluateMetadata } from '../sessions/evaluate/route'
import { POST as cancelSession, metadata as cancelMetadata } from '../sessions/cancel/route'
import { POST as finaliseSessionRoute } from '../sessions/finalise/route'

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/product_configurator${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function getRequest(path: string): Request {
  return new Request(`http://localhost/api/product_configurator${path}`)
}

function storedSession(): ConfigurationSession {
  return Object.assign(new ConfigurationSession(), {
    id: SESSION_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    modelVersionId: VERSION_ID,
    quoteId: QUOTE_ID,
    selections: { size: 'l' },
    evaluation: { netPrice: '10.00' },
    revision: 4,
    mode: 'new',
    migration: null,
    status: 'open',
    createdBy: USER_ID,
    createdAt: new Date('2026-11-06T09:00:00.000Z'),
    updatedAt: new Date('2026-11-06T10:00:00.000Z'),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  getAuthFromRequestMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID })
  runRouteMutationGuardsMock.mockResolvedValue({ ok: true, modifiedPayload: null, runAfterSuccess: jest.fn(async () => undefined) })
  userHasAllFeaturesMock.mockResolvedValue(true)
})

describe('session routes metadata', () => {
  it('requires the configurator and sales quote view features on every operation', () => {
    const features = ['product_configurator.sessions.manage', 'sales.quotes.view']
    expect(sessionsMetadata.GET.requireFeatures).toEqual(features)
    expect(sessionsMetadata.POST.requireFeatures).toEqual(features)
    expect(evaluateMetadata.POST.requireFeatures).toEqual(features)
    expect(cancelMetadata.POST.requireFeatures).toEqual(features)
  })
})

describe('POST /sessions', () => {
  it('runs the mutation guards, executes the open command and answers 201', async () => {
    commandExecuteMock.mockResolvedValue({ result: { sessionId: SESSION_ID } })
    const response = await openSession(postRequest('/sessions', { quoteId: QUOTE_ID }))
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ sessionId: SESSION_ID })
    expect(runRouteMutationGuardsMock.mock.calls[0][0].input).toMatchObject({
      resourceKind: 'product_configurator.session',
      operation: 'create',
      mutationPayload: { quoteId: QUOTE_ID },
    })
    expect(commandExecuteMock).toHaveBeenCalledWith('product_configurator.sessions.open', expect.objectContaining({ input: { quoteId: QUOTE_ID } }))
  })

  it('stops when a mutation guard blocks the open', async () => {
    runRouteMutationGuardsMock.mockResolvedValue({ ok: false, response: new Response(null, { status: 422 }) })
    const response = await openSession(postRequest('/sessions', { quoteId: QUOTE_ID }))
    expect(response.status).toBe(422)
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })

  it('answers 400 organization_scope_required with all organizations selected', async () => {
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT_ID })
    const response = await openSession(postRequest('/sessions', { quoteId: QUOTE_ID }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'organization_scope_required' })
  })
})

describe('POST /sessions/evaluate', () => {
  it('answers 413 payload_too_large above 64 KB without running the command', async () => {
    const response = await evaluateSession(
      postRequest('/sessions/evaluate', { id: SESSION_ID, revision: 0, selections: { note: 'x'.repeat(70 * 1024) } }),
    )
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ code: 'payload_too_large' })
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a body without a revision', async () => {
    const response = await evaluateSession(postRequest('/sessions/evaluate', { id: SESSION_ID, selections: {} }))
    expect(response.status).toBe(400)
  })

  it('executes the evaluate command with the guarded payload', async () => {
    commandExecuteMock.mockResolvedValue({ result: { id: SESSION_ID, revision: 1 } })
    const response = await evaluateSession(postRequest('/sessions/evaluate', { id: SESSION_ID, revision: 0, selections: { size: 'l' } }))
    expect(response.status).toBe(200)
    expect(commandExecuteMock).toHaveBeenCalledWith(
      'product_configurator.sessions.evaluate',
      expect.objectContaining({ input: { id: SESSION_ID, revision: 0, selections: { size: 'l' } } }),
    )
  })
})

describe('POST /sessions/cancel', () => {
  it('returns the new status', async () => {
    commandExecuteMock.mockResolvedValue({ result: { id: SESSION_ID, status: 'cancelled' } })
    const response = await cancelSession(postRequest('/sessions/cancel', { id: SESSION_ID }))
    await expect(response.json()).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('POST /sessions/finalise', () => {
  const HASH = 'a'.repeat(64)
  const body = { id: SESSION_ID, expectedHash: HASH, revision: 4 }

  it('runs the mutation guards as an update of the session and stops when one blocks it', async () => {
    runRouteMutationGuardsMock.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'Locked' }), { status: 423 }) })
    const response = await finaliseSessionRoute(postRequest('/sessions/finalise', body))
    expect(response.status).toBe(423)
    expect(runRouteMutationGuardsMock.mock.calls[0][0].input).toMatchObject({
      resourceKind: 'product_configurator.session',
      resourceId: SESSION_ID,
      operation: 'update',
      mutationPayload: body,
    })
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })

  it('finalises the payload a guard modified and runs its after-success hook', async () => {
    const runAfterSuccess = jest.fn(async () => undefined)
    const modified = { ...body, migrationAcknowledged: true }
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, modifiedPayload: modified, runAfterSuccess })
    const finalised = { snapshotId: VERSION_ID, quoteLineId: MODEL_ID, hash: HASH, replay: false, outcome: 'added' }
    commandExecuteMock.mockResolvedValue({ result: finalised })

    const response = await finaliseSessionRoute(postRequest('/sessions/finalise', body))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(finalised)
    expect(commandExecuteMock).toHaveBeenCalledWith('product_configurator.sessions.finalise', expect.objectContaining({ input: modified }))
    expect(runAfterSuccess).toHaveBeenCalledTimes(1)
  })

  it('answers 400 when a guard returns a payload that is not a valid finalise request', async () => {
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, modifiedPayload: { id: 'not-a-uuid' }, runAfterSuccess: jest.fn() })
    const response = await finaliseSessionRoute(postRequest('/sessions/finalise', body))
    expect(response.status).toBe(400)
    expect(commandExecuteMock).not.toHaveBeenCalled()
  })
})

describe('GET /sessions', () => {
  it('needs exactly one of id and quoteId', async () => {
    expect((await getSessions(getRequest('/sessions'))).status).toBe(400)
    expect((await getSessions(getRequest(`/sessions?id=${SESSION_ID}&quoteId=${QUOTE_ID}`))).status).toBe(400)
  })

  it('re-checks the features and answers 403 without sales visibility', async () => {
    userHasAllFeaturesMock.mockResolvedValue(false)
    const response = await getSessions(getRequest(`/sessions?id=${SESSION_ID}`))
    expect(response.status).toBe(403)
    expect(findOneWithDecryptionMock).not.toHaveBeenCalled()
  })

  it('returns the session with its version, the quote header and the creator name', async () => {
    findOneWithDecryptionMock.mockResolvedValue(storedSession())
    findWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === ConfigurationModelVersion) {
        return [Object.assign(new ConfigurationModelVersion(), { id: VERSION_ID, modelId: MODEL_ID, version: 2, hash: 'h', definition: { schemaVersion: 1 } })]
      }
      if (entity === ConfigurationModel) return [Object.assign(new ConfigurationModel(), { id: MODEL_ID, title: 'Pump' })]
      return []
    })
    queryMock.mockImplementation(async (entityId: string) =>
      entityId === 'auth:user'
        ? { items: [{ id: USER_ID, name: 'Ann Lee', email: 'ann@example.com' }] }
        : { items: [{ id: QUOTE_ID, quote_number: 'Q-7', currency_code: 'EUR', customer_snapshot: { customer: { displayName: 'Acme' } } }] },
    )

    const response = await getSessions(getRequest(`/sessions?id=${SESSION_ID}`))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: SESSION_ID,
      status: 'open',
      mode: 'new',
      revision: 4,
      quoteId: QUOTE_ID,
      sourceSnapshotId: null,
      sourceLineName: null,
      quote: { id: QUOTE_ID, number: 'Q-7', customerName: 'Acme', currencyCode: 'EUR' },
      modelVersion: { id: VERSION_ID, version: 2, hash: 'h', modelId: MODEL_ID, modelTitle: 'Pump', definition: { schemaVersion: 1 } },
      selections: { size: 'l' },
      evaluation: { netPrice: '10.00' },
      migration: null,
      createdBy: { id: USER_ID, displayName: 'Ann Lee' },
      createdAt: '2026-11-06T09:00:00.000Z',
      updatedAt: '2026-11-06T10:00:00.000Z',
    })
    expect(findOneWithDecryptionMock.mock.calls[0][2]).toEqual({ id: SESSION_ID, tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('names the source line of a copy, and null once that line is gone', async () => {
    const SNAPSHOT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const migration = { fromVersion: { id: VERSION_ID, version: 1 }, toVersion: { id: VERSION_ID, version: 2 }, kept: [], dropped: [], reset: [] }
    findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) =>
      entity === ConfigurationSnapshot
        ? Object.assign(new ConfigurationSnapshot(), { id: SNAPSHOT_ID, quoteLineId: LINE_ID })
        : Object.assign(storedSession(), { mode: 'duplicate', sourceSnapshotId: SNAPSHOT_ID, migration }),
    )
    findWithDecryptionMock.mockResolvedValue([])
    const lines: Array<Record<string, unknown>> = [{ id: LINE_ID, quote_id: QUOTE_ID, name: 'Pump, blue' }]
    queryMock.mockImplementation(async (entityId: string) => {
      if (entityId === 'sales:sales_quote_line') return { items: lines }
      if (entityId === 'auth:user') return { items: [] }
      return { items: [{ id: QUOTE_ID, currency_code: 'EUR' }] }
    })

    const present = await getSessions(getRequest(`/sessions?id=${SESSION_ID}`))
    await expect(present.json()).resolves.toMatchObject({ mode: 'duplicate', sourceSnapshotId: SNAPSHOT_ID, sourceLineName: 'Pump, blue', migration })
    expect(findOneWithDecryptionMock.mock.calls[1][2]).toEqual({ id: SNAPSHOT_ID, tenantId: TENANT_ID, organizationId: ORG_ID })

    lines.length = 0
    const removed = await getSessions(getRequest(`/sessions?id=${SESSION_ID}`))
    await expect(removed.json()).resolves.toMatchObject({ sourceSnapshotId: SNAPSHOT_ID, sourceLineName: null })
  })

  it('answers 404 for a session outside the selected organization', async () => {
    findOneWithDecryptionMock.mockResolvedValue(null)
    const response = await getSessions(getRequest(`/sessions?id=${SESSION_ID}`))
    expect(response.status).toBe(404)
  })

  it('lists the sessions of a quote that are in progress by default', async () => {
    findWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => (entity === ConfigurationSession ? [storedSession()] : []))
    queryMock.mockResolvedValue({ items: [] })
    const response = await getSessions(getRequest(`/sessions?quoteId=${QUOTE_ID}`))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ id: SESSION_ID, status: 'open', sourceSnapshotId: null, createdBy: { id: USER_ID, displayName: null } })
    expect(body.items[0]).not.toHaveProperty('evaluation')
    expect(findWithDecryptionMock.mock.calls[0][2]).toEqual({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      quoteId: QUOTE_ID,
      status: { $in: ['open', 'finalising'] },
    })
  })
})
