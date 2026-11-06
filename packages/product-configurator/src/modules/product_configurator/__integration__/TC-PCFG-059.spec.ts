import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finaliseOk, readSnapshots } from './helpers/finalise'
import { evaluateStoredSelections, openCopy } from './helpers/copies'

type Snapshot = { id: string; lineState: string; lineId: string | null }

test.describe('TC-PCFG-059: "Configure again" on a removed line', () => {
  test('a configuration whose line was deleted opens as a copy and finalise adds a new line', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '059')
      const source = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const removed = await apiRequest(request, 'DELETE', '/api/sales/quote-lines', { token, data: { id: source.quoteLineId, quoteId: fixture.quoteId } })
      expect(removed.ok(), await removed.text()).toBeTruthy()
      const before = (await readJsonSafe<{ items: Snapshot[] }>(await readSnapshots(request, token, `quoteId=${fixture.quoteId}`)))?.items ?? []
      expect(before).toEqual([expect.objectContaining({ id: source.snapshotId, lineState: 'removed', lineId: null })])

      const copy = await openCopy(request, token, cleanup, { quoteId: fixture.quoteId, fromSnapshotId: source.snapshotId })
      expect(copy).toMatchObject({ mode: 'duplicate', sourceSnapshotId: source.snapshotId, migration: null })
      const session = await readJsonSafe<{ sourceLineName: string | null }>(
        await apiRequest(request, 'GET', `/api/product_configurator/sessions?id=${copy.sessionId}`, { token }),
      )
      expect(session?.sourceLineName).toBeNull()

      const evaluated = await evaluateStoredSelections(request, token, copy.sessionId)
      const added = await finaliseOk(request, token, { id: copy.sessionId, expectedHash: evaluated.evaluation.hash, revision: evaluated.revision })

      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines.map((line) => line.id)).toEqual([added.quoteLineId])
      const after = (await readJsonSafe<{ items: Snapshot[] }>(await readSnapshots(request, token, `quoteId=${fixture.quoteId}`)))?.items ?? []
      expect(after.map((item) => [item.id, item.lineState])).toEqual([
        [source.snapshotId, 'removed'],
        [added.snapshotId, 'present'],
      ])
    } finally {
      await cleanup.run()
    }
  })
})
