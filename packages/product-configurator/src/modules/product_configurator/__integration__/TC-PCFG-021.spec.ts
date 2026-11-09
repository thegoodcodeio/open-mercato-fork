import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, createQuote, createSinglePartModel, openSession, readSession } from './helpers/sessions'

test.describe('TC-PCFG-021: the model currency must match the quote currency', () => {
  test('opening a EUR model on a USD quote answers 409 currency_mismatch and creates no session', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()

    try {
      const model = await createSinglePartModel(request, token, cleanup, '021')
      const quoteId = await createQuote(request, token, cleanup, { currencyCode: 'USD' })

      const response = await openSession(request, token, { quoteId, modelId: model.modelId })
      expect(response.status()).toBe(409)
      expect(await readJsonSafe(response)).toMatchObject({
        code: 'currency_mismatch',
        params: { modelCurrency: 'EUR', quoteCurrency: 'USD' },
      })

      const sessions = await readSession(request, token, `quoteId=${quoteId}&status=open,finalising,finalised,cancelled`)
      expect(sessions.status()).toBe(200)
      expect((await readJsonSafe<{ items: unknown[] }>(sessions))?.items).toEqual([])
    } finally {
      await cleanup.run()
    }
  })
})
