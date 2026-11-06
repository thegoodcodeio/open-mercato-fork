import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'
import { Cleanup, readSession, SESSION_FEATURES } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise } from './helpers/finalise'

test.describe('TC-PCFG-039: finalising needs quote edit rights', () => {
  test('a user who can configure and view quotes, but not manage them, gets 403 and nothing is written', async ({ request }) => {
    test.setTimeout(120_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    let viewer: ScopedUser | null = null
    try {
      const fixture = await createConfiguredSession(request, adminToken, cleanup, '039')
      viewer = await createUserWithFeatures(request, superadminToken, 'no-manage', SESSION_FEATURES, getTokenContext(adminToken))

      const response = await finalise(request, viewer.token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(response.status()).toBe(403)

      const session = await readJsonSafe<{ status: string; revision: number }>(await readSession(request, viewer.token, `id=${fixture.sessionId}`))
      expect(session).toMatchObject({ status: 'open', revision: fixture.revision })
      expect(configuredLines(await documentLines(request, adminToken, 'quote', fixture.quoteId))).toEqual([])
    } finally {
      await cleanup.run()
      await deleteScopedUser(request, superadminToken, viewer)
    }
  })
})
