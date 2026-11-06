import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { MODELS_PATH } from './helpers/fixtures'
import { Cleanup, readSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise } from './helpers/finalise'

test.describe('TC-PCFG-040: finalise on a deleted model', () => {
  test('answers 409 model_deleted, keeps the session open and writes nothing', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '040')
      const deleted = await apiRequest(request, 'DELETE', `${MODELS_PATH}?id=${encodeURIComponent(fixture.modelId)}`, { token })
      expect(deleted.ok(), `DELETE ${MODELS_PATH}: ${deleted.status()} ${await deleted.text()}`).toBeTruthy()

      const response = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(response.status()).toBe(409)
      expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('model_deleted')
      const session = await readJsonSafe<{ status: string }>(await readSession(request, token, `id=${fixture.sessionId}`))
      expect(session?.status).toBe('open')
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toEqual([])
    } finally {
      await cleanup.run()
    }
  })
})
