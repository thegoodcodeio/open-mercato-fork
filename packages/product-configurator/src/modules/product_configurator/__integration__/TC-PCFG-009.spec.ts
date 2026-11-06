import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { CATALOG_ITEMS_PATH, PREVIEW_PATH, PUBLISH_PATH, VALIDATE_PATH } from './helpers/fixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'

test.describe('TC-PCFG-009: catalog reads need catalog.products.view', () => {
  test('a model manager without catalog.products.view gets 403 on catalog items, validate, publish and preview', async ({ request }) => {
    const superadminToken = await getAuthToken(request, 'superadmin')
    let manager: ScopedUser | null = null

    try {
      manager = await createUserWithFeatures(request, superadminToken, 'no-catalog', [
        'product_configurator.models.view',
        'product_configurator.models.manage',
      ])

      const response = await apiRequest(request, 'GET', `${CATALOG_ITEMS_PATH}?skus=ANY`, { token: manager.token })
      expect(response.status()).toBe(403)
      const validate = await apiRequest(request, 'POST', VALIDATE_PATH, { token: manager.token, data: { id: randomUUID() } })
      expect(validate.status(), 'validate needs catalog.products.view').toBe(403)
      const publish = await apiRequest(request, 'POST', PUBLISH_PATH, { token: manager.token, data: { id: randomUUID() } })
      expect(publish.status(), 'publish needs catalog.products.view').toBe(403)
      const preview = await apiRequest(request, 'POST', PREVIEW_PATH, { token: manager.token, data: { id: randomUUID(), selections: {} } })
      expect(preview.status(), 'preview needs catalog.products.view').toBe(403)
    } finally {
      await deleteScopedUser(request, superadminToken, manager)
    }
  })
})
