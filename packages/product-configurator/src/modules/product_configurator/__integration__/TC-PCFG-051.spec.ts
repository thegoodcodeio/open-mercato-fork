import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, evaluateOk, evaluateSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise, finaliseOk } from './helpers/finalise'

test.describe('TC-PCFG-051: stale revision on evaluate and on finalise', () => {
  test('both answer session_changed with the current state; finalise on the current revision succeeds', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '051')
      const current = await evaluateOk(request, token, { id: fixture.sessionId, revision: fixture.revision, selections: { size: 's' } })

      const staleEvaluate = await evaluateSession(request, token, { id: fixture.sessionId, revision: fixture.revision, selections: { size: 'l' } })
      expect(staleEvaluate.status()).toBe(409)
      expect(await readJsonSafe(staleEvaluate)).toMatchObject({ code: 'session_changed', session: { revision: current.revision, selections: { size: 's' } } })

      const staleFinalise = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(staleFinalise.status()).toBe(409)
      expect(await readJsonSafe(staleFinalise)).toMatchObject({
        code: 'session_changed',
        session: { status: 'open', revision: current.revision, selections: { size: 's' } },
      })
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toEqual([])

      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: current.evaluation.hash, revision: current.revision })
      expect(result.hash).toBe(current.evaluation.hash)
    } finally {
      await cleanup.run()
    }
  })
})
