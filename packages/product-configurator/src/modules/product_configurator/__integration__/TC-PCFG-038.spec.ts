import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import { configuredLines, convertQuote, createConfiguredSession, documentLines, finaliseOk, lineConfiguration, readSnapshots } from './helpers/finalise'

type Snapshot = { id: string; quoteId: string; quoteLineId: string | null; lineState: string; lineId: string | null; lineName: string | null; netPrice: string }

test.describe('TC-PCFG-038: a converted order keeps the configuration and the order tab finds it', () => {
  test('the order line carries the marker; GET /snapshots?orderId= and ?id=&orderId= return the snapshot on that line', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '038', { title: 'QA PCFG 038 pump' })
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)

      const [orderLine] = configuredLines(await documentLines(request, token, 'order', orderId))
      expect(orderLine.id).toBe(result.quoteLineId)
      expect(lineConfiguration(orderLine)).toMatchObject({ productConfigurator: { snapshotId: result.snapshotId, hash: fixture.evaluation.hash } })

      const byOrder = await readSnapshots(request, token, `orderId=${orderId}`)
      expect(byOrder.status(), await byOrder.text()).toBe(200)
      const body = await readJsonSafe<{ items: Snapshot[]; truncated: boolean }>(byOrder)
      expect(body?.truncated).toBe(false)
      expect(body?.items).toEqual([
        expect.objectContaining({
          id: result.snapshotId,
          quoteId: fixture.quoteId,
          quoteLineId: result.quoteLineId,
          lineState: 'present',
          lineId: orderLine.id,
          lineName: 'QA PCFG 038 pump',
          netPrice: '100.0000',
        }),
      ])

      const one = await readSnapshots(request, token, `id=${result.snapshotId}&orderId=${orderId}`)
      expect(one.status()).toBe(200)
      expect(await readJsonSafe<Snapshot>(one)).toMatchObject({ id: result.snapshotId, lineState: 'present', lineId: orderLine.id })

      const narrowed = await readJsonSafe<{ items: Snapshot[] }>(await readSnapshots(request, token, `orderId=${orderId}&ids=${result.snapshotId}`))
      expect(narrowed?.items.map((item) => item.id)).toEqual([result.snapshotId])
    } finally {
      await cleanup.run()
    }
  })
})
