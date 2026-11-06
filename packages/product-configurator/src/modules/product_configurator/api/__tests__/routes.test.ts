/** @jest-environment node */
import { ConfigurationModel } from '../../data/entities'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const MODEL_ID = '33333333-3333-4333-8333-333333333333'
const VERSION_ID = '44444444-4444-4444-8444-444444444444'

const getAuthFromRequestMock = jest.fn()
const resolveOrganizationScopeMock = jest.fn()
const runRouteMutationGuardsMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const findAndCountWithDecryptionMock = jest.fn()
const validateModelDraftMock = jest.fn()
const commandExecuteMock = jest.fn()
const resolveSkusMock = jest.fn()
const queryMock = jest.fn()
const em = { fork: () => em }

const container = {
  resolve: (token: string) => {
    if (token === 'em') return em
    if (token === 'commandBus') return { execute: commandExecuteMock }
    if (token === 'catalogPriceRowService') return { resolveSkus: resolveSkusMock }
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
  findAndCountWithDecryption: (...args: unknown[]) => findAndCountWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({ catalog: { catalog_price_kind: 'catalog:catalog_price_kind' } }),
}))

jest.mock('../../lib/modelValidation', () => ({
  validateModelDraft: (...args: unknown[]) => validateModelDraftMock(...args),
}))

import { GET as getCatalogItems, metadata as catalogItemsMetadata } from '../catalog-items/route'
import { POST as publish, metadata as publishMetadata } from '../models/publish/route'
import { POST as validate, metadata as validateMetadata } from '../models/validate/route'
import { PUT as putModel, buildModelListFilters } from '../models/route'
import { GET as getVersions } from '../model-versions/route'
import { GET as getPriceKinds, metadata as priceKindsMetadata } from '../price-kinds/route'

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/product_configurator${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getRequest(path: string): Request {
  return new Request(`http://localhost/api/product_configurator${path}`)
}

function liveModel(): ConfigurationModel {
  return Object.assign(new ConfigurationModel(), {
    id: MODEL_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    productId: '55555555-5555-4555-8555-555555555555',
    latestVersionId: VERSION_ID,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  getAuthFromRequestMock.mockResolvedValue({ sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID })
  resolveOrganizationScopeMock.mockResolvedValue({ selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: null, tenantId: TENANT_ID })
})

describe('GET /catalog-items', () => {
  it('requires both the model management and the catalog view features', () => {
    expect(catalogItemsMetadata.GET.requireFeatures).toEqual(['product_configurator.models.manage', 'catalog.products.view'])
  })

  it('returns titles and base units and lists unknown and ambiguous SKUs in the selected organization', async () => {
    resolveSkusMock.mockResolvedValue({
      items: new Map([['PUMP-1', { sku: 'PUMP-1', productId: 'p1', variantId: null, title: 'Pump body', unit: 'pc', salesUnitQuantity: '1' }]]),
      ambiguous: ['DUP-1'],
    })

    const response = await getCatalogItems(getRequest('/catalog-items?skus=PUMP-1,%20NOPE,DUP-1,PUMP-1'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      items: [{ sku: 'PUMP-1', title: 'Pump body', unit: 'pc' }],
      unknown: ['NOPE'],
      ambiguous: ['DUP-1'],
    })
    expect(resolveSkusMock).toHaveBeenCalledWith(em, ['PUMP-1', 'NOPE', 'DUP-1'], { tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('rejects more than 100 SKUs', async () => {
    const skus = Array.from({ length: 101 }, (_, index) => `SKU-${index}`).join(',')

    const response = await getCatalogItems(getRequest(`/catalog-items?skus=${skus}`))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'too_many_skus' })
    expect(resolveSkusMock).not.toHaveBeenCalled()
  })

  it('answers 400 organization_scope_required when all organizations are selected', async () => {
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT_ID })

    const response = await getCatalogItems(getRequest('/catalog-items?skus=PUMP-1'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'organization_scope_required' })
  })
})

describe('GET /price-kinds', () => {
  const PRICE_KIND_ID = '66666666-6666-4666-8666-666666666666'
  const rows = [
    { id: PRICE_KIND_ID, code: 'regular', title: 'Regular price', is_active: true },
    { id: '77777777-7777-4777-8777-777777777777', code: 'b2b-net', title: 'Wholesale', is_active: true },
    { id: '88888888-8888-4888-8888-888888888888', code: 'promo', title: 'Spring sale', is_active: true },
  ]

  function pageResult(items: unknown[], total = items.length) {
    return { items, total, page: 1, pageSize: 100 }
  }

  it('requires only the model management feature', () => {
    expect(priceKindsMetadata.GET).toEqual({ requireAuth: true, requireFeatures: ['product_configurator.models.manage'] })
  })

  it('reads the kinds of the organization and tenant-wide kinds through the query engine', async () => {
    queryMock.mockResolvedValue(pageResult(rows))

    const response = await getPriceKinds(getRequest('/price-kinds?isActive=true'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toHaveLength(3)
    expect(body.items[0]).toEqual({ id: PRICE_KIND_ID, code: 'regular', title: 'Regular price', isActive: true })
    expect(queryMock).toHaveBeenCalledWith(
      'catalog:catalog_price_kind',
      expect.objectContaining({
        tenantId: TENANT_ID,
        organizationIds: [ORG_ID, ''],
        filters: { is_active: { $eq: true } },
      }),
    )
  })

  it('matches the search text anywhere in the title or code, ignoring case', async () => {
    queryMock.mockResolvedValue(pageResult(rows))

    const byTitle = await getPriceKinds(getRequest('/price-kinds?search=SALE'))
    const byCode = await getPriceKinds(getRequest('/price-kinds?search=net'))

    expect((await byTitle.json()).items.map((item: { title: string }) => item.title)).toEqual(['Wholesale', 'Spring sale'])
    expect((await byCode.json()).items.map((item: { code: string }) => item.code)).toEqual(['b2b-net'])
    expect(queryMock.mock.calls[0][1].filters).toEqual({})
  })

  it('resolves kinds by id', async () => {
    queryMock.mockResolvedValue(pageResult([rows[0]]))

    const response = await getPriceKinds(getRequest(`/price-kinds?ids=${PRICE_KIND_ID}&pageSize=1`))

    expect(response.status).toBe(200)
    expect((await response.json()).items).toHaveLength(1)
    expect(queryMock.mock.calls[0][1].filters).toEqual({ id: { $in: [PRICE_KIND_ID] } })
  })

  it('reads further pages before searching and limits the answer to pageSize', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
      code: `kind-${index}`,
      title: `Kind ${index}`,
      is_active: true,
    }))
    queryMock
      .mockResolvedValueOnce(pageResult(firstPage, 101))
      .mockResolvedValueOnce(pageResult([rows[2]], 101))
      .mockResolvedValueOnce(pageResult(firstPage, 101))
      .mockResolvedValueOnce(pageResult([rows[2]], 101))

    const response = await getPriceKinds(getRequest('/price-kinds?search=sale&pageSize=5'))
    const all = await getPriceKinds(getRequest('/price-kinds?pageSize=5'))

    expect((await response.json()).items.map((item: { code: string }) => item.code)).toEqual(['promo'])
    expect(queryMock.mock.calls[1][1].page).toEqual({ page: 2, pageSize: 100 })
    expect((await all.json()).items).toHaveLength(5)
  })

  it('rejects ids that are not uuids', async () => {
    const response = await getPriceKinds(getRequest('/price-kinds?ids=nope'))

    expect(response.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('answers 400 organization_scope_required when all organizations are selected', async () => {
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT_ID })

    const response = await getPriceKinds(getRequest('/price-kinds'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'organization_scope_required' })
  })
})

describe('PUT /models', () => {
  it('returns the saved draft hash next to the new lock token', async () => {
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, runAfterSuccess: jest.fn(async () => undefined) })
    const saved = { id: MODEL_ID, updatedAt: '2026-11-05T10:00:00.000Z', draftHash: 'draft-hash' }
    commandExecuteMock.mockResolvedValue({ result: saved, logEntry: null })

    const response = await putModel(
      new Request('http://localhost/api/product_configurator/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: MODEL_ID, title: 'Pump XL' }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(saved)
    expect(commandExecuteMock).toHaveBeenCalledWith(
      'product_configurator.models.update',
      expect.objectContaining({ input: expect.objectContaining({ id: MODEL_ID, title: 'Pump XL' }) }),
    )
  })
})

describe('GET /models list filters', () => {
  const query = { page: 1, pageSize: 25 }

  it('lists only the selected organization, not its child organizations', () => {
    expect(buildModelListFilters(query, { selectedOrganizationId: ORG_ID })).toEqual({ organization_id: { $eq: ORG_ID } })
  })

  it('keeps the scope filter next to the query filters', () => {
    expect(buildModelListFilters({ ...query, id: MODEL_ID, search: 'pump' }, { selectedOrganizationId: ORG_ID })).toEqual({
      organization_id: { $eq: ORG_ID },
      id: { $eq: MODEL_ID },
      $or: [{ title: { $ilike: '%pump%' } }, { model_key: { $ilike: '%pump%' } }],
    })
  })

  it('leaves the organization to the automatic scope when all organizations are selected', () => {
    expect(buildModelListFilters(query, { selectedOrganizationId: null })).toEqual({})
  })
})

describe('POST /models/validate', () => {
  it('requires both the model management and the catalog view features', () => {
    expect(validateMetadata.POST.requireFeatures).toEqual(['product_configurator.models.manage', 'catalog.products.view'])
  })

  it('returns the report of the saved draft', async () => {
    findOneWithDecryptionMock.mockResolvedValue(liveModel())
    validateModelDraftMock.mockResolvedValue({ ok: true, issues: [] })

    const response = await validate(postRequest('/models/validate', { id: MODEL_ID }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, issues: [] })
    expect(findOneWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationModel,
      { id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID, deletedAt: null },
      undefined,
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
  })

  it('returns 404 for a model of another organization', async () => {
    findOneWithDecryptionMock.mockResolvedValue(null)

    const response = await validate(postRequest('/models/validate', { id: MODEL_ID }))

    expect(response.status).toBe(404)
    expect(validateModelDraftMock).not.toHaveBeenCalled()
  })

  it('answers 400 when all organizations are selected', async () => {
    resolveOrganizationScopeMock.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT_ID })

    const response = await validate(postRequest('/models/validate', { id: MODEL_ID }))

    expect(response.status).toBe(400)
  })
})

describe('POST /models/publish', () => {
  it('requires both the model management and the catalog view features', () => {
    expect(publishMetadata.POST.requireFeatures).toEqual(['product_configurator.models.manage', 'catalog.products.view'])
  })

  it('returns the guard response when a mutation guard blocks publish', async () => {
    runRouteMutationGuardsMock.mockResolvedValue({
      ok: false,
      errorStatus: 423,
      errorBody: { error: 'Locked' },
      response: Response.json({ error: 'Locked' }, { status: 423 }),
    })

    const response = await publish(postRequest('/models/publish', { id: MODEL_ID }))

    expect(response.status).toBe(423)
    expect(commandExecuteMock).not.toHaveBeenCalled()
    expect(runRouteMutationGuardsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { userId: 'user-1', tenantId: TENANT_ID, organizationId: ORG_ID },
        input: expect.objectContaining({ resourceKind: 'product_configurator.model', resourceId: MODEL_ID, operation: 'custom' }),
      }),
    )
  })

  it('runs the publish command and the after-success callbacks', async () => {
    const runAfterSuccess = jest.fn(async () => undefined)
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, runAfterSuccess })
    const published = { modelVersionId: VERSION_ID, version: 1, hash: 'abc', updatedAt: '2026-11-02T00:00:00.000Z' }
    commandExecuteMock.mockResolvedValue({ result: published, logEntry: null })

    const response = await publish(postRequest('/models/publish', { id: MODEL_ID }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(published)
    expect(commandExecuteMock).toHaveBeenCalledWith(
      'product_configurator.models.publish',
      expect.objectContaining({ input: { id: MODEL_ID }, ctx: expect.objectContaining({ selectedOrganizationId: ORG_ID }) }),
    )
    expect(runAfterSuccess).toHaveBeenCalled()
  })

  it('maps a failed validation to 422 with the report', async () => {
    const { CrudHttpError } = await import('@open-mercato/shared/lib/crud/errors')
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, runAfterSuccess: jest.fn() })
    const report = { ok: false, issues: [] }
    commandExecuteMock.mockRejectedValue(new CrudHttpError(422, { error: 'x', code: 'validation_failed', report }))

    const response = await publish(postRequest('/models/publish', { id: MODEL_ID }))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'validation_failed', report })
  })
})

describe('GET /model-versions', () => {
  it('lists the versions of a live model without definitions', async () => {
    findOneWithDecryptionMock.mockResolvedValue(liveModel())
    findAndCountWithDecryptionMock.mockResolvedValue([
      [{ id: VERSION_ID, modelId: MODEL_ID, version: 2, hash: 'h2', publishedAt: new Date('2026-11-02T00:00:00.000Z') }],
      1,
    ])

    const response = await getVersions(getRequest(`/model-versions?modelId=${MODEL_ID}`))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toEqual([
      { id: VERSION_ID, modelId: MODEL_ID, version: 2, hash: 'h2', publishedAt: '2026-11-02T00:00:00.000Z', isLatest: true },
    ])
    expect(findAndCountWithDecryptionMock).toHaveBeenCalledWith(
      em,
      expect.anything(),
      { modelId: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID },
      expect.objectContaining({ fields: ['id', 'modelId', 'version', 'hash', 'publishedAt'] }),
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
  })

  it('returns 404 for a version outside the organization', async () => {
    findOneWithDecryptionMock.mockResolvedValue(null)

    const response = await getVersions(getRequest(`/model-versions?id=${VERSION_ID}`))

    expect(response.status).toBe(404)
  })

  it('needs exactly one of modelId and id', async () => {
    const response = await getVersions(getRequest('/model-versions'))

    expect(response.status).toBe(400)
  })
})
