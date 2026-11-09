import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, cancelSession, createQuote, createSinglePartModel, evaluateOk, evaluateSession, openSessionId, readSession } from './helpers/sessions'

test.describe('TC-PCFG-026: discarding a configuration', () => {
  test('cancel ends an open session; evaluate and cancel afterwards answer 409 session_not_open', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()

    try {
      const model = await createSinglePartModel(request, token, cleanup, '026')
      const quoteId = await createQuote(request, token, cleanup)
      const sessionId = await openSessionId(request, token, cleanup, { quoteId, modelId: model.modelId })
      const evaluated = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: { size: 'l' } })
      expect(evaluated.evaluation.netPrice).toBe('100.00')

      const cancelled = await cancelSession(request, token, sessionId)
      expect(cancelled.status()).toBe(200)
      expect(await readJsonSafe(cancelled)).toEqual({ status: 'cancelled' })

      const afterCancel = await evaluateSession(request, token, { id: sessionId, revision: 1, selections: { size: 's' } })
      expect(afterCancel.status()).toBe(409)
      expect(await readJsonSafe(afterCancel)).toMatchObject({ code: 'session_not_open', status: 'cancelled' })
      const cancelAgain = await cancelSession(request, token, sessionId)
      expect(cancelAgain.status()).toBe(409)

      const stored = await readSession(request, token, `id=${sessionId}`)
      expect(await readJsonSafe(stored)).toMatchObject({ status: 'cancelled', revision: 1, selections: { size: 'l' } })
      const inProgress = await readSession(request, token, `quoteId=${quoteId}`)
      expect((await readJsonSafe<{ items: unknown[] }>(inProgress))?.items).toEqual([])
      const cancelledList = await readSession(request, token, `quoteId=${quoteId}&status=cancelled`)
      expect((await readJsonSafe<{ items: Array<{ id: string }> }>(cancelledList))?.items.map((item) => item.id)).toEqual([sessionId])
    } finally {
      await cleanup.run()
    }
  })
})
