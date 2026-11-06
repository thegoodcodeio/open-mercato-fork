import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, openSessionId, readSession } from './helpers/sessions'
import { convertQuote, createConfiguredSession } from './helpers/finalise'

test.describe('TC-PCFG-056: converting a quote cancels its open sessions', () => {
  test('every open session of the converted quote ends as cancelled', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '056')
      const secondSessionId = await openSessionId(request, token, cleanup, { quoteId: fixture.quoteId, modelId: fixture.modelId })

      await convertQuote(request, token, cleanup, fixture.quoteId)

      for (const sessionId of [fixture.sessionId, secondSessionId]) {
        const session = await readJsonSafe<{ status: string; quote: unknown }>(await readSession(request, token, `id=${sessionId}`))
        expect(session).toMatchObject({ status: 'cancelled', quote: null })
      }
    } finally {
      await cleanup.run()
    }
  })
})
