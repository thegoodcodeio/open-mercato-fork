/** @jest-environment node */
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999'
const ORG_ID = '22222222-2222-4222-8222-222222222222'

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const container = { resolve: jest.fn() }

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
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

import { readLimitedJsonObject, resolveRouteContext, type RouteContext } from '../helpers'

const request = () => new Request('http://localhost/api/product_configurator/models/validate', { method: 'POST' })

beforeEach(() => {
  jest.clearAllMocks()
})

describe('resolveRouteContext', () => {
  it('uses the tenant of the resolved scope for a superadmin acting in another tenant', async () => {
    getAuthFromRequestMock.mockResolvedValue({ sub: 'admin-1', tenantId: OTHER_TENANT_ID, orgId: null, isSuperAdmin: true })
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: null, tenantId: TENANT_ID })

    const context = (await resolveRouteContext(request())) as RouteContext

    expect(context.scope).toEqual({ tenantId: TENANT_ID, organizationId: ORG_ID })
    expect(context.ctx.auth).toEqual({ sub: 'admin-1', tenantId: TENANT_ID, orgId: ORG_ID, isSuperAdmin: true })
    expect(context.ctx.selectedOrganizationId).toBe(ORG_ID)
    expect(context.userId).toBe('admin-1')
  })

  it('falls back to the token tenant when the scope names none', async () => {
    getAuthFromRequestMock.mockResolvedValue({ sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID })
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: null, tenantId: null })

    const context = (await resolveRouteContext(request())) as RouteContext

    expect(context.scope).toEqual({ tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('answers 401 without an authenticated user', async () => {
    getAuthFromRequestMock.mockResolvedValue(null)

    const response = (await resolveRouteContext(request())) as Response

    expect(response.status).toBe(401)
    expect(resolveOrganizationScopeMock).not.toHaveBeenCalled()
  })

  it('answers 401 for a token whose tenant is not a UUID, like makeCrudRoute', async () => {
    getAuthFromRequestMock.mockResolvedValue({ sub: 'user-1', tenantId: 'not-a-uuid', orgId: ORG_ID })

    const response = (await resolveRouteContext(request())) as Response

    expect(response.status).toBe(401)
    expect(resolveOrganizationScopeMock).not.toHaveBeenCalled()
  })

  it('answers 400 organization_scope_required when no single organization is selected', async () => {
    getAuthFromRequestMock.mockResolvedValue({ sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID })
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: null, tenantId: TENANT_ID, selectionRejected: true })

    const response = (await resolveRouteContext(request())) as Response

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'organization_scope_required' })
  })
})

describe('readLimitedJsonObject', () => {
  it('answers 413 from a content-length above the limit without reading the body', async () => {
    const req = new Request('http://localhost/api/product_configurator/sessions/evaluate', {
      method: 'POST',
      headers: { 'content-length': '65537' },
      body: '{}',
    })
    const text = jest.spyOn(req, 'text')

    const response = (await readLimitedJsonObject(req, 65_536)) as Response

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ code: 'payload_too_large' })
    expect(text).not.toHaveBeenCalled()
  })

  it('answers 413 for a larger body without content-length and reads a body within the limit', async () => {
    const tooLarge = new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(100) }) })
    tooLarge.headers.delete('content-length')
    expect(((await readLimitedJsonObject(tooLarge, 50)) as Response).status).toBe(413)

    const small = new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ id: 'a' }) })
    await expect(readLimitedJsonObject(small, 50)).resolves.toEqual({ id: 'a' })
  })

  it('stops reading a chunked body at the limit and never pulls the rest of the stream', async () => {
    const encoder = new TextEncoder()
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(encoder.encode(pulled === 1 ? '{"text":"' : 'x'.repeat(40)))
      },
    })
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
    const chunked = new Request('http://localhost/x', init)
    expect(((await readLimitedJsonObject(chunked, 100)) as Response).status).toBe(413)
    expect(pulled).toBeLessThanOrEqual(5)

    const multiByte = new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ name: 'Żółw' }) })
    await expect(readLimitedJsonObject(multiByte, 50)).resolves.toEqual({ name: 'Żółw' })
    await expect(readLimitedJsonObject(new Request('http://localhost/x', { method: 'POST' }), 50)).resolves.toEqual({})
  })
})
