import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  ALL_ORGANIZATIONS,
  CATALOG_ITEMS_PATH,
  MODELS_PATH,
  PUBLISH_PATH,
  VALIDATE_PATH,
  VERSIONS_PATH,
  createModelFixture,
  deleteModelIfExists,
  uniqueSuffix,
} from './helpers/fixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'

const MANAGER_FEATURES = ['product_configurator.models.view', 'product_configurator.models.manage', 'catalog.products.view']

test.describe('TC-PCFG-004: organization and tenant scoping of models', () => {
  test('a model of another organization is invisible, and "all organizations" is rejected on custom routes', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const { organizationId: homeOrganizationId, tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    let otherOrganizationId: string | null = null
    let modelId: string | null = null

    try {
      otherOrganizationId = await createOrganizationFixture(request, token, { name: `QA PCFG 004 ${suffix}`, tenantId })
      modelId = await createModelFixture(request, token, {
        productId: randomUUID(),
        priceKindId: randomUUID(),
        selectedOrgId: otherOrganizationId,
      })

      const ownRead = await apiRequestWithSelectedOrg(request, 'GET', `${MODELS_PATH}?id=${modelId}`, {
        token,
        selectedOrgId: otherOrganizationId,
      })
      expect(ownRead.status(), 'the owning organization reads its model').toBe(200)

      const fromHome = { token, selectedOrgId: homeOrganizationId }
      const crossRead = await apiRequestWithSelectedOrg(request, 'GET', `${MODELS_PATH}?id=${modelId}`, fromHome)
      expect(crossRead.status()).toBe(404)
      const crossList = await apiRequestWithSelectedOrg(request, 'GET', `${MODELS_PATH}?pageSize=100`, fromHome)
      const crossListBody = await readJsonSafe<{ items?: Array<{ id: string }> }>(crossList)
      expect(crossListBody?.items?.some((item) => item.id === modelId) ?? false).toBe(false)
      const crossVersions = await apiRequestWithSelectedOrg(request, 'GET', `${VERSIONS_PATH}?modelId=${modelId}`, fromHome)
      expect(crossVersions.status()).toBe(404)
      const crossValidate = await apiRequestWithSelectedOrg(request, 'POST', VALIDATE_PATH, { ...fromHome, data: { id: modelId } })
      expect(crossValidate.status()).toBe(404)
      const crossPublish = await apiRequestWithSelectedOrg(request, 'POST', PUBLISH_PATH, { ...fromHome, data: { id: modelId } })
      expect(crossPublish.status()).toBe(404)
      const crossUpdate = await apiRequestWithSelectedOrg(request, 'PUT', MODELS_PATH, { ...fromHome, data: { id: modelId, title: 'Hijack' } })
      expect(crossUpdate.status()).toBe(404)

      const allOrganizations = { token, selectedOrgId: ALL_ORGANIZATIONS }
      for (const [method, path, data] of [
        ['POST', VALIDATE_PATH, { id: modelId }],
        ['POST', PUBLISH_PATH, { id: modelId }],
        ['GET', `${CATALOG_ITEMS_PATH}?skus=ANY`, undefined],
        ['GET', `${VERSIONS_PATH}?modelId=${modelId}`, undefined],
      ] as const) {
        const response = await apiRequestWithSelectedOrg(request, method, path, { ...allOrganizations, data })
        expect(response.status(), `${method} ${path} with all organizations`).toBe(400)
        expect((await readJsonSafe<{ code?: string }>(response))?.code).toBe('organization_scope_required')
      }
    } finally {
      await deleteModelIfExists(request, token, modelId, otherOrganizationId ?? undefined)
      await deleteOrganizationIfExists(request, token, otherOrganizationId)
    }
  })

  test('a model of another tenant is invisible to a manager of the home tenant, and the reverse', async ({ request }) => {
    test.setTimeout(120_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const suffix = uniqueSuffix()
    let foreignTenantId: string | null = null
    let foreignOrganizationId: string | null = null
    let foreignAdmin: ScopedUser | null = null
    let homeManager: ScopedUser | null = null
    let foreignModelId: string | null = null
    let homeModelId: string | null = null

    try {
      const tenantResponse = await apiRequest(request, 'POST', '/api/directory/tenants', {
        token: superadminToken,
        data: { name: `QA PCFG 004 tenant ${suffix}` },
      })
      expect(tenantResponse.status(), 'POST /api/directory/tenants should return 201').toBe(201)
      foreignTenantId = expectId((await readJsonSafe<{ id?: string }>(tenantResponse))?.id, 'Tenant create should return an id')
      foreignOrganizationId = await createOrganizationFixture(request, superadminToken, {
        name: `QA PCFG 004 foreign ${suffix}`,
        tenantId: foreignTenantId,
      })
      foreignAdmin = await createUserWithFeatures(request, superadminToken, 'foreign-admin', MANAGER_FEATURES, {
        tenantId: foreignTenantId,
        organizationId: foreignOrganizationId,
      })
      homeManager = await createUserWithFeatures(request, superadminToken, 'home-manager', MANAGER_FEATURES)

      foreignModelId = await createModelFixture(request, foreignAdmin.token, { productId: randomUUID(), priceKindId: randomUUID() })
      homeModelId = await createModelFixture(request, homeManager.token, { productId: randomUUID(), priceKindId: randomUUID() })

      const asHome = { token: homeManager.token }
      const homeRead = await apiRequest(request, 'GET', `${MODELS_PATH}?id=${foreignModelId}`, asHome)
      expect(homeRead.status(), 'detail of a foreign-tenant model').toBe(404)
      const homeList = await apiRequest(request, 'GET', `${MODELS_PATH}?pageSize=100`, asHome)
      const homeListBody = await readJsonSafe<{ items?: Array<{ id: string }> }>(homeList)
      expect(homeListBody?.items?.some((item) => item.id === foreignModelId) ?? false, 'list of the home tenant').toBe(false)
      for (const [method, path, data] of [
        ['GET', `${VERSIONS_PATH}?modelId=${foreignModelId}`, undefined],
        ['POST', VALIDATE_PATH, { id: foreignModelId }],
        ['POST', PUBLISH_PATH, { id: foreignModelId }],
        ['PUT', MODELS_PATH, { id: foreignModelId, title: 'Hijack' }],
        ['DELETE', `${MODELS_PATH}?id=${foreignModelId}`, undefined],
      ] as const) {
        const response = await apiRequest(request, method, path, { ...asHome, data })
        expect(response.status(), `${method} ${path} on a foreign-tenant model`).toBe(404)
      }

      const foreignRead = await apiRequest(request, 'GET', `${MODELS_PATH}?id=${homeModelId}`, { token: foreignAdmin.token })
      expect(foreignRead.status(), 'the foreign tenant cannot read a home-tenant model').toBe(404)
      const foreignValidate = await apiRequest(request, 'POST', VALIDATE_PATH, { token: foreignAdmin.token, data: { id: homeModelId } })
      expect(foreignValidate.status()).toBe(404)

      const ownerRead = await apiRequest(request, 'GET', `${MODELS_PATH}?id=${foreignModelId}`, { token: foreignAdmin.token })
      const ownerBody = await readJsonSafe<{ items?: Array<{ id: string; title: string }> }>(ownerRead)
      expect(ownerBody?.items?.[0], 'the foreign model is unchanged and not deleted').toMatchObject({ id: foreignModelId, title: 'QA configurator model' })

      const superadminInForeignTenant = await apiRequest(request, 'POST', VALIDATE_PATH, {
        token: superadminToken,
        headers: { Cookie: `om_selected_tenant=${foreignTenantId}; om_selected_org=${foreignOrganizationId}` },
        data: { id: foreignModelId },
      })
      expect(superadminInForeignTenant.status(), 'a superadmin acting in the foreign tenant reaches its model on a custom route').toBe(200)
    } finally {
      await deleteModelIfExists(request, foreignAdmin?.token ?? null, foreignModelId)
      await deleteModelIfExists(request, homeManager?.token ?? null, homeModelId)
      await deleteScopedUser(request, superadminToken, foreignAdmin)
      await deleteScopedUser(request, superadminToken, homeManager)
      await deleteOrganizationIfExists(request, superadminToken, foreignOrganizationId)
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/directory/tenants', foreignTenantId)
    }
  })
})
