import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, cancelSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise } from './helpers/finalise'

test.describe('TC-PCFG-060: finalise of a discarded session', () => {
  test('answers 409 session_not_open with the status and adds nothing', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '060')
      expect((await cancelSession(request, token, fixture.sessionId)).status()).toBe(200)

      const response = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(response.status()).toBe(409)
      expect(await readJsonSafe(response)).toMatchObject({ code: 'session_not_open', status: 'cancelled' })
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toEqual([])
    } finally {
      await cleanup.run()
    }
  })
})
