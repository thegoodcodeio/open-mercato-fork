import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, createPrice, readSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise, finaliseOk, lineField } from './helpers/finalise'

test.describe('TC-PCFG-050: catalog price changed after the last evaluate', () => {
  test('finalise answers result_changed with the new result and writes nothing; confirming the new hash succeeds', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '050')
      const removed = await apiRequest(request, 'DELETE', `/api/catalog/prices?id=${encodeURIComponent(fixture.priceId)}`, { token })
      expect(removed.ok(), await removed.text()).toBeTruthy()
      await createPrice(request, token, cleanup, { productId: fixture.partProductId, priceKindId: fixture.priceKindId, unitPriceNet: '120.00' })

      const changed = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(changed.status()).toBe(409)
      const body = await readJsonSafe<{ code: string; result: { netPrice: string; hash: string } }>(changed)
      expect(body?.code).toBe('result_changed')
      expect(body?.result.netPrice).toBe('120.00')
      expect(body?.result.hash).not.toBe(fixture.evaluation.hash)
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toEqual([])
      const session = await readJsonSafe<{ status: string; revision: number }>(await readSession(request, token, `id=${fixture.sessionId}`))
      expect(session).toMatchObject({ status: 'open', revision: fixture.revision })

      const confirmed = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: body?.result.hash ?? '', revision: fixture.revision })
      const [line] = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(line.id).toBe(confirmed.quoteLineId)
      expect(Number(lineField(line, 'unitPriceNet'))).toBe(120)
    } finally {
      await cleanup.run()
    }
  })
})
