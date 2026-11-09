import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, readSession } from './helpers/sessions'
import { configuredLines, convertQuote, createConfiguredSession, documentLines, finalise, finaliseOk, readQuoteRecord } from './helpers/finalise'

// The "quote edited between steps 3 and 5 -> quote_changed" half cannot be timed over HTTP: the lock
// token is read inside finalise. It is covered by lib/__tests__/finalise.test.ts (sales 409) and by the
// check below that an edit made before finalise does not conflict.
test.describe('TC-PCFG-033: the quote changes during configuration', () => {
  test('a quote converted between open and finalise answers quote_converted, cancels the session and writes nothing', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '033')
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)

      const response = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(response.status()).toBe(409)
      expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('quote_converted')
      const session = await readJsonSafe<{ status: string }>(await readSession(request, token, `id=${fixture.sessionId}`))
      expect(session?.status).toBe('cancelled')
      expect(configuredLines(await documentLines(request, token, 'order', orderId))).toHaveLength(0)
    } finally {
      await cleanup.run()
    }
  })

  test('a quote edited before finalise does not conflict: the lock token is read inside finalise', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '033B')
      const before = await readQuoteRecord(request, token, fixture.quoteId)
      const edited = await apiRequest(request, 'PUT', '/api/sales/quotes', {
        token,
        data: { id: fixture.quoteId, comments: 'Edited while configuring' },
      })
      expect(edited.ok(), `PUT /api/sales/quotes failed: ${edited.status()} ${await edited.text()}`).toBeTruthy()
      const after = await readQuoteRecord(request, token, fixture.quoteId)
      expect(after?.updated_at ?? after?.updatedAt).not.toEqual(before?.updated_at ?? before?.updatedAt)

      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(result.replay).toBe(false)
    } finally {
      await cleanup.run()
    }
  })
})
