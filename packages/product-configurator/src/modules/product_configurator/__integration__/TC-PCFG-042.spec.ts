import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, readSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise } from './helpers/finalise'

const SESSION_RESOURCE_KIND = 'product_configurator.session'

type RecordLockSettings = { enabled: boolean; strategy: string; enabledResources: string[] } & Record<string, unknown>

// The registered guard is the enterprise record_locks guard, so the test skips itself when that module is off.
test.describe('TC-PCFG-042: a registered mutation guard blocks finalise', () => {
  test('finalise answers 423 while another user holds a pessimistic lock on the session', async ({ request }) => {
    test.setTimeout(120_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const settingsResponse = await apiRequest(request, 'GET', '/api/record_locks/settings', { token: superadminToken })
    test.skip(settingsResponse.status() === 404, 'record_locks module is not enabled in this app')
    expect(settingsResponse.status()).toBe(200)
    const previousSettings = (await readJsonSafe<{ settings?: RecordLockSettings }>(settingsResponse))?.settings ?? null
    expect(previousSettings).toBeTruthy()
    const homeOrganizationId = getTokenContext(adminToken).organizationId
    const cleanup = new Cleanup()
    let sessionId: string | null = null
    let lockToken: string | null = null
    let completed = false
    try {
      const fixture = await createConfiguredSession(request, adminToken, cleanup, '042')
      sessionId = fixture.sessionId
      const enabled = await apiRequest(request, 'POST', '/api/record_locks/settings', {
        token: superadminToken,
        data: { ...previousSettings, enabled: true, strategy: 'pessimistic', enabledResources: [SESSION_RESOURCE_KIND] },
      })
      expect(enabled.status(), `POST /api/record_locks/settings: ${await enabled.text()}`).toBe(200)
      const acquire = await apiRequestWithSelectedOrg(request, 'POST', '/api/record_locks/acquire', {
        token: superadminToken,
        selectedOrgId: homeOrganizationId,
        data: { resourceKind: SESSION_RESOURCE_KIND, resourceId: sessionId },
      })
      expect(acquire.status()).toBe(200)
      lockToken = (await readJsonSafe<{ lock?: { token?: string } }>(acquire))?.lock?.token ?? null
      expect(lockToken, 'POST /api/record_locks/acquire should return the lock token').toBeTruthy()

      const blocked = await finalise(request, adminToken, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(blocked.status()).toBe(423)
      const session = await readJsonSafe<{ status: string }>(await readSession(request, adminToken, `id=${fixture.sessionId}`))
      expect(session?.status).toBe('open')
      expect(configuredLines(await documentLines(request, adminToken, 'quote', fixture.quoteId))).toEqual([])
      completed = true
    } finally {
      const restoreFailures: string[] = []
      if (lockToken && sessionId) {
        const released = await apiRequestWithSelectedOrg(request, 'POST', '/api/record_locks/release', {
          token: superadminToken,
          selectedOrgId: homeOrganizationId,
          data: { resourceKind: SESSION_RESOURCE_KIND, resourceId: sessionId, token: lockToken, reason: 'cancelled' },
        })
        if (!released.ok()) restoreFailures.push(`release lock: ${released.status()} ${await released.text()}`)
      }
      if (previousSettings) {
        const restored = await apiRequest(request, 'POST', '/api/record_locks/settings', { token: superadminToken, data: previousSettings })
        if (restored.status() !== 200) restoreFailures.push(`restore settings: ${restored.status()} ${await restored.text()}`)
      }
      await cleanup.run()
      if (completed) expect(restoreFailures, 'record_locks state must be restored for the next tests').toEqual([])
      else if (restoreFailures.length) test.info().annotations.push({ type: 'restore-failures', description: restoreFailures.join('; ') })
    }
  })
})
