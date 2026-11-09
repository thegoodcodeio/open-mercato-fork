import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, createQuote, openSession } from './helpers/sessions'
import { createConfiguredSession, finaliseOk } from './helpers/finalise'

test.describe('TC-PCFG-041: copy source and mode checks on open', () => {
  test('a snapshot of another quote answers 422 snapshot_not_in_quote; replace and other combinations answer 400 mode_not_supported', async ({ request }) => {
    test.setTimeout(150_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '041')
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const otherQuoteId = await createQuote(request, token, cleanup)

      const otherQuote = await openSession(request, token, { quoteId: otherQuoteId, fromSnapshotId: result.snapshotId })
      expect(otherQuote.status(), await otherQuote.text()).toBe(422)
      expect((await readJsonSafe<{ code: string }>(otherQuote))?.code).toBe('snapshot_not_in_quote')

      const refused: Array<Record<string, unknown>> = [
        { quoteId: fixture.quoteId, fromSnapshotId: result.snapshotId, mode: 'replace' },
        { quoteId: fixture.quoteId, mode: 'replace' },
        { quoteId: fixture.quoteId, mode: 'duplicate' },
        { quoteId: fixture.quoteId, fromSnapshotId: result.snapshotId, mode: 'new' },
      ]
      for (const data of refused) {
        const response = await openSession(request, token, data)
        expect(response.status(), JSON.stringify(data)).toBe(400)
        expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('mode_not_supported')
      }
    } finally {
      await cleanup.run()
    }
  })
})
