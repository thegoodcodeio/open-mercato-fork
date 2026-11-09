import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'
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

test.describe('TC-PCFG-025: every session operation needs sales visibility of quotes', () => {
  test('a user with the configurator feature but without sales.quotes.view gets 403 on open, evaluate, get and cancel', async ({ request }) => {
    test.setTimeout(120_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    let configuratorOnly: ScopedUser | null = null

    try {
      const model = await createSinglePartModel(request, adminToken, cleanup, '025')
      const quoteId = await createQuote(request, adminToken, cleanup)
      const sessionId = await openSessionId(request, adminToken, cleanup, { quoteId, modelId: model.modelId })
      configuratorOnly = await createUserWithFeatures(request, superadminToken, 'no-sales', ['product_configurator.sessions.manage'], getTokenContext(adminToken))
      const token = configuratorOnly.token

      const responses = {
        open: await openSession(request, token, { quoteId, modelId: model.modelId }),
        evaluate: await evaluateSession(request, token, { id: sessionId, revision: 0, selections: {} }),
        get: await readSession(request, token, `id=${sessionId}`),
        list: await readSession(request, token, `quoteId=${quoteId}`),
        cancel: await cancelSession(request, token, sessionId),
      }
      for (const [operation, response] of Object.entries(responses)) {
        expect(response.status(), `${operation} without sales.quotes.view`).toBe(403)
      }

      const unchanged = await readSession(request, adminToken, `id=${sessionId}`)
      expect(await readJsonSafe(unchanged)).toMatchObject({ status: 'open', revision: 0 })
    } finally {
      await cleanup.run()
      await deleteScopedUser(request, superadminToken, configuratorOnly)
    }
  })
})
