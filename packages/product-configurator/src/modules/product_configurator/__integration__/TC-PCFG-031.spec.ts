import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise, finaliseOk, type FinaliseBody } from './helpers/finalise'

test.describe('TC-PCFG-031: finalise replay is idempotent', () => {
  test('finalising a finalised session returns its stored result and adds no second line', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '031')
      const input = { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision }
      const first = await finaliseOk(request, token, input)

      const replay = await finalise(request, token, input)
      expect(replay.status()).toBe(200)
      expect(await readJsonSafe<FinaliseBody>(replay)).toEqual({ ...first, replay: true })

      const staleReplay = await finalise(request, token, { ...input, revision: 0, expectedHash: 'stale' })
      expect(staleReplay.status()).toBe(200)
      expect(await readJsonSafe<FinaliseBody>(staleReplay)).toMatchObject({ quoteLineId: first.quoteLineId, replay: true })

      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId)).map((line) => line.id)).toEqual([first.quoteLineId])
    } finally {
      await cleanup.run()
    }
  })
})
