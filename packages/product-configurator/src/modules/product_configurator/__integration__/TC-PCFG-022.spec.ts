import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, cancelSession, createQuote, createSinglePartModel, openSession } from './helpers/sessions'

// CHF keeps the candidate list small; other published CHF models of the organization may still
// be candidates, so the assertions only require both models of this test to be among them.
const CURRENCY = 'CHF'

test.describe('TC-PCFG-022: several fitting models need an explicit model', () => {
  test('two published models and no modelId answer model_required with the candidates, then the chosen model opens', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()

    try {
      const first = await createSinglePartModel(request, token, cleanup, '022A', { currencyCode: CURRENCY })
      const second = await createSinglePartModel(request, token, cleanup, '022B', { currencyCode: CURRENCY })
      const quoteId = await createQuote(request, token, cleanup, { currencyCode: CURRENCY })

      const ambiguous = await openSession(request, token, { quoteId })
      expect(ambiguous.status()).toBe(409)
      const body = await readJsonSafe<{ code: string; candidateIds: string[] }>(ambiguous)
      expect(body?.code).toBe('model_required')
      expect(body?.candidateIds).toEqual(expect.arrayContaining([first.modelId, second.modelId]))

      const chosen = await openSession(request, token, { quoteId, modelId: second.modelId })
      expect(chosen.status()).toBe(201)
      const opened = await readJsonSafe<{ sessionId: string; modelVersion: { id: string; modelId: string } }>(chosen)
      cleanup.add(() => cancelSession(request, token, opened?.sessionId ?? ''))
      expect(opened?.modelVersion).toMatchObject({ id: second.modelVersionId, modelId: second.modelId })
    } finally {
      await cleanup.run()
    }
  })
})
