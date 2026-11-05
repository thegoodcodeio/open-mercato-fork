import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { MODEL_RESOURCE_KIND, createModelFixture, deleteModelIfExists, publishModel, readModel } from './helpers/fixtures'

type RecordLockSettings = { enabled: boolean; strategy: string; enabledResources: string[] } & Record<string, unknown>

// The registered guard is the enterprise record_locks guard, so the test skips itself when that module is off.
test.describe('TC-PCFG-006: a registered mutation guard blocks publish', () => {
  test.describe.configure({ timeout: 90_000 })

  test('publish answers 423 while another user holds a pessimistic lock on the model', async ({ request }) => {
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const settingsResponse = await apiRequest(request, 'GET', '/api/record_locks/settings', { token: superadminToken })
    test.skip(settingsResponse.status() === 404, 'record_locks module is not enabled in this app')
    expect(settingsResponse.status()).toBe(200)
    const previousSettings = (await readJsonSafe<{ settings?: RecordLockSettings }>(settingsResponse))?.settings ?? null
    expect(previousSettings).toBeTruthy()
    const homeOrganizationId = getTokenContext(superadminToken).organizationId
    expect(getTokenContext(adminToken).organizationId).toBe(homeOrganizationId)

    let modelId: string | null = null
    let lockToken: string | null = null
    try {
      await apiRequest(request, 'POST', '/api/record_locks/settings', {
        token: superadminToken,
        data: { ...previousSettings, enabled: true, strategy: 'pessimistic', enabledResources: [MODEL_RESOURCE_KIND] },
      })
      modelId = await createModelFixture(request, adminToken, { productId: randomUUID(), priceKindId: randomUUID() })

      const acquire = await apiRequestWithSelectedOrg(request, 'POST', '/api/record_locks/acquire', {
        token: superadminToken,
        selectedOrgId: homeOrganizationId,
        data: { resourceKind: MODEL_RESOURCE_KIND, resourceId: modelId },
      })
      expect(acquire.status()).toBe(200)
      lockToken = (await readJsonSafe<{ lock?: { token?: string } }>(acquire))?.lock?.token ?? null
      expect(lockToken).toBeTruthy()

      const model = await readModel(request, adminToken, modelId)
      const blocked = await publishModel(request, adminToken, modelId, model.updatedAt)
      expect(blocked.status()).toBe(423)
      const versions = await readModel(request, adminToken, modelId)
      expect(versions.latestVersion).toBeNull()
    } finally {
      if (lockToken && modelId) {
        await apiRequestWithSelectedOrg(request, 'POST', '/api/record_locks/release', {
          token: superadminToken,
          selectedOrgId: homeOrganizationId,
          data: { resourceKind: MODEL_RESOURCE_KIND, resourceId: modelId, token: lockToken, reason: 'cancelled' },
        }).catch(() => undefined)
      }
      await deleteModelIfExists(request, adminToken, modelId)
      if (previousSettings) {
        await apiRequest(request, 'POST', '/api/record_locks/settings', { token: superadminToken, data: previousSettings }).catch(() => undefined)
      }
    }
  })
})
