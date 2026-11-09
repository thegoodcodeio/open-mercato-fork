import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, readSession } from './helpers/sessions'
import {
  configuredLines,
  createConfiguredSession,
  createTaxRate,
  documentLines,
  finalise,
  finaliseOk,
  setProductTaxRate,
} from './helpers/finalise'

// Sales refuses the line write when the bound product's tax rate was deleted (400 from the tax service),
// which is a line write failure that is neither a conflict nor a missing quote.
test.describe('TC-PCFG-032: a failed line write leaves the session reopenable', () => {
  test('502 quote_line_write_failed keeps the session open; a retry after the fix adds exactly one line', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const taxRateId = await createTaxRate(request, token, cleanup, 23)
      const fixture = await createConfiguredSession(request, token, cleanup, '032', { taxRateId })
      const deleted = await apiRequest(request, 'DELETE', `/api/sales/tax-rates?id=${encodeURIComponent(taxRateId)}`, { token })
      expect(deleted.ok()).toBeTruthy()

      const input = { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision }
      const failed = await finalise(request, token, input)
      expect(failed.status()).toBe(502)
      expect((await readJsonSafe<{ code: string }>(failed))?.code).toBe('quote_line_write_failed')
      const session = await readJsonSafe<{ status: string; revision: number }>(await readSession(request, token, `id=${fixture.sessionId}`))
      expect(session).toMatchObject({ status: 'open', revision: fixture.revision })
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toEqual([])

      await setProductTaxRate(request, token, fixture.productId, null)
      const retried = await finaliseOk(request, token, input)
      expect(retried.replay).toBe(false)
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId)).map((line) => line.id)).toEqual([retried.quoteLineId])
    } finally {
      await cleanup.run()
    }
  })
})
