import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { ALL_ORGANIZATIONS, uniqueSuffix } from './helpers/fixtures'
import {
  Cleanup,
  cancelSession,
  createQuote,
  createSinglePartModel,
  evaluateSession,
  openSession,
  openSessionId,
  readSession,
} from './helpers/sessions'

test.describe('TC-PCFG-024: sessions follow the selected organization', () => {
  test('switching the selected organization hides the session and its quote; all organizations is rejected', async ({ request }) => {
    test.setTimeout(120_000)
    const adminToken = await getAuthToken(request, 'admin')
    const token = await getAuthToken(request, 'superadmin')
    const { organizationId: homeOrganizationId, tenantId } = getTokenContext(adminToken)
    const cleanup = new Cleanup()
    let otherOrganizationId: string | null = null

    try {
      const model = await createSinglePartModel(request, adminToken, cleanup, '024')
      const quoteId = await createQuote(request, adminToken, cleanup)
      const sessionId = await openSessionId(request, adminToken, cleanup, { quoteId, modelId: model.modelId })
      otherOrganizationId = await createOrganizationFixture(request, token, { name: `QA PCFG 024 ${uniqueSuffix()}`, tenantId })

      const home = { selectedOrgId: homeOrganizationId }
      expect((await readSession(request, token, `id=${sessionId}`, home)).status()).toBe(200)
      const homeList = await readSession(request, token, `quoteId=${quoteId}`, home)
      expect((await readJsonSafe<{ items: Array<{ id: string }> }>(homeList))?.items.map((item) => item.id)).toEqual([sessionId])

      const other = { selectedOrgId: otherOrganizationId }
      expect((await readSession(request, token, `id=${sessionId}`, other)).status()).toBe(404)
      const otherList = await readSession(request, token, `quoteId=${quoteId}`, other)
      expect(otherList.status()).toBe(200)
      expect((await readJsonSafe<{ items: unknown[] }>(otherList))?.items).toEqual([])
      expect((await evaluateSession(request, token, { id: sessionId, revision: 0, selections: {} }, other)).status()).toBe(404)
      expect((await cancelSession(request, token, sessionId, other)).status()).toBe(404)
      const crossOpen = await openSession(request, token, { quoteId, modelId: model.modelId }, other)
      expect(crossOpen.status()).toBe(404)
      expect((await readJsonSafe<{ code: string }>(crossOpen))?.code).toBe('quote_not_found')

      const all = { selectedOrgId: ALL_ORGANIZATIONS }
      for (const response of [
        await readSession(request, token, `id=${sessionId}`, all),
        await openSession(request, token, { quoteId, modelId: model.modelId }, all),
        await evaluateSession(request, token, { id: sessionId, revision: 0, selections: {} }, all),
        await cancelSession(request, token, sessionId, all),
      ]) {
        expect(response.status()).toBe(400)
        expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('organization_scope_required')
      }

      const stillOpen = await readSession(request, token, `id=${sessionId}`, home)
      expect(await readJsonSafe(stillOpen)).toMatchObject({ status: 'open', revision: 0 })
    } finally {
      await cleanup.run()
      await deleteOrganizationIfExists(request, token, otherOrganizationId)
    }
  })
})
