import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'
import {
  Cleanup,
  SESSION_FEATURES,
  createQuote,
  createSinglePartModel,
  evaluateOk,
  evaluateSession,
  openSessionId,
  readSession,
} from './helpers/sessions'

test.describe('TC-PCFG-028: sessions are shared within the organization', () => {
  test('another rep resumes a session, a stale revision is refused, and revoked sales access blocks the rep', async ({ request }) => {
    test.setTimeout(180_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenContext(adminToken)
    const cleanup = new Cleanup()
    let repA: ScopedUser | null = null
    let repB: ScopedUser | null = null

    try {
      const model = await createSinglePartModel(request, adminToken, cleanup, '028')
      const quoteId = await createQuote(request, adminToken, cleanup)
      repA = await createUserWithFeatures(request, superadminToken, 'rep-a', SESSION_FEATURES, scope)
      repB = await createUserWithFeatures(request, superadminToken, 'rep-b', SESSION_FEATURES, scope)

      const sessionId = await openSessionId(request, repA.token, cleanup, { quoteId, modelId: model.modelId })
      await evaluateOk(request, repA.token, { id: sessionId, revision: 0, selections: { size: 'l' } })

      const resumed = await readSession(request, repB.token, `id=${sessionId}`)
      expect(resumed.status()).toBe(200)
      expect(await readJsonSafe(resumed)).toMatchObject({
        status: 'open',
        revision: 1,
        selections: { size: 'l' },
        createdBy: { id: repA.userId, displayName: 'QA PCFG rep-a' },
      })
      const continued = await evaluateOk(request, repB.token, { id: sessionId, revision: 1, selections: { size: 's' } })
      expect(continued.revision).toBe(2)

      const stale = await evaluateSession(request, repA.token, { id: sessionId, revision: 1, selections: { size: 'l' } })
      expect(stale.status(), 'TC-PCFG-051: a stale revision on evaluate').toBe(409)
      expect(await readJsonSafe(stale)).toMatchObject({
        code: 'session_changed',
        session: { id: sessionId, status: 'open', revision: 2, selections: { size: 's' } },
      })

      await setRoleAclFeatures(request, superadminToken, { roleId: repB.roleId, features: ['product_configurator.sessions.manage'], organizations: null })
      expect((await readSession(request, repB.token, `id=${sessionId}`)).status()).toBe(403)
      expect((await evaluateSession(request, repB.token, { id: sessionId, revision: 2, selections: {} })).status()).toBe(403)

      const afterRevoke = await readSession(request, repA.token, `id=${sessionId}`)
      expect(await readJsonSafe(afterRevoke)).toMatchObject({ revision: 2, selections: { size: 's' } })
    } finally {
      await cleanup.run()
      await deleteScopedUser(request, superadminToken, repA)
      await deleteScopedUser(request, superadminToken, repB)
    }
  })
})
