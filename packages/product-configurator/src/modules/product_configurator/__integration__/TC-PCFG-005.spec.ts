import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
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

test.describe('TC-PCFG-005: each feature gates its routes', () => {
  test.describe.configure({ timeout: 120_000 })

  test('view, manage and no-grant users reach exactly the routes their features allow', async ({ request }) => {
    const superadminToken = await getAuthToken(request, 'superadmin')
    const { organizationId: homeOrganizationId } = getTokenContext(superadminToken)
    let viewer: ScopedUser | null = null
    let manager: ScopedUser | null = null
    let outsider: ScopedUser | null = null
    let modelId: string | null = null

    try {
      modelId = await createModelFixture(request, superadminToken, {
        productId: randomUUID(),
        priceKindId: randomUUID(),
        selectedOrgId: homeOrganizationId,
      })
      viewer = await createUserWithFeatures(request, superadminToken, 'viewer', ['product_configurator.models.view'])
      manager = await createUserWithFeatures(request, superadminToken, 'manager', [
        'product_configurator.models.view',
        'product_configurator.models.manage',
        'catalog.products.view',
      ])
      outsider = await createUserWithFeatures(request, superadminToken, 'outsider', ['catalog.products.view'])

      const create = { productId: randomUUID(), priceKindId: randomUUID(), modelKey: `qa-pcfg-005-${uniqueSuffix()}`, title: 'Gate', currencyCode: 'EUR' }
      const calls = [
        { name: 'list models', method: 'GET', path: `${MODELS_PATH}?pageSize=10`, feature: 'view' },
        { name: 'read versions', method: 'GET', path: `${VERSIONS_PATH}?modelId=${modelId}`, feature: 'view' },
        { name: 'create model', method: 'POST', path: MODELS_PATH, data: create, feature: 'manage' },
        { name: 'update model', method: 'PUT', path: MODELS_PATH, data: { id: modelId, title: 'Renamed' }, feature: 'manage' },
        { name: 'validate model', method: 'POST', path: VALIDATE_PATH, data: { id: modelId }, feature: 'manage' },
        { name: 'publish model', method: 'POST', path: PUBLISH_PATH, data: { id: modelId }, feature: 'manage' },
        { name: 'catalog items', method: 'GET', path: `${CATALOG_ITEMS_PATH}?skus=ANY`, feature: 'manage' },
      ] as const

      for (const call of calls) {
        const asOutsider = await apiRequest(request, call.method, call.path, { token: outsider.token, data: 'data' in call ? call.data : undefined })
        expect(asOutsider.status(), `${call.name} without product_configurator features`).toBe(403)

        const asViewer = await apiRequest(request, call.method, call.path, { token: viewer.token, data: 'data' in call ? call.data : undefined })
        if (call.feature === 'view') {
          expect(asViewer.status(), `${call.name} with models.view`).toBe(200)
        } else {
          expect(asViewer.status(), `${call.name} needs models.manage`).toBe(403)
        }
      }

      const validateAsManager = await apiRequest(request, 'POST', VALIDATE_PATH, { token: manager.token, data: { id: modelId } })
      expect(validateAsManager.status()).toBe(200)
      const itemsAsManager = await apiRequest(request, 'GET', `${CATALOG_ITEMS_PATH}?skus=ANY`, { token: manager.token })
      expect(itemsAsManager.status()).toBe(200)
    } finally {
      await deleteModelIfExists(request, superadminToken, modelId, homeOrganizationId)
      await deleteScopedUser(request, superadminToken, viewer)
      await deleteScopedUser(request, superadminToken, manager)
      await deleteScopedUser(request, superadminToken, outsider)
    }
  })
})
