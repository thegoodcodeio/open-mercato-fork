import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, createPrice } from './helpers/sessions'
import { configuredLines, createConfiguredSession, createTaxRate, documentLines, finaliseOk, lineField, readQuoteRecord } from './helpers/finalise'
import { evaluateStoredSelections, openCopy, updateLine } from './helpers/copies'

test.describe('TC-PCFG-054: "Add another identical" adds a separate, re-priced line', () => {
  test('the copy gets new-line defaults and the current price; the source line keeps its terms and price', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const taxRateId = await createTaxRate(request, token, cleanup, 17.5)
      const fixture = await createConfiguredSession(request, token, cleanup, '054', { taxRateId, title: 'QA PCFG 054 pump' })
      const source = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })

      const quote = await readQuoteRecord(request, token, fixture.quoteId)
      const lockToken = String(quote?.updated_at ?? quote?.updatedAt ?? '')
      expect(lockToken, 'the quote has an updatedAt lock token').toBeTruthy()
      const edited = await updateLine(
        request,
        token,
        { quoteId: fixture.quoteId, lineId: source.quoteLineId, name: 'Pump for hall A', comment: 'Agreed with the buyer', discount: { mode: 'percent', value: 10 } },
        lockToken,
      )
      expect(edited.status(), await edited.text()).toBe(200)

      const removed = await apiRequest(request, 'DELETE', `/api/catalog/prices?id=${encodeURIComponent(fixture.priceId)}`, { token })
      expect(removed.ok(), await removed.text()).toBeTruthy()
      await createPrice(request, token, cleanup, { productId: fixture.partProductId, priceKindId: fixture.priceKindId, unitPriceNet: '150.00' })

      const copy = await openCopy(request, token, cleanup, { quoteId: fixture.quoteId, fromSnapshotId: source.snapshotId })
      expect(copy).toMatchObject({ mode: 'duplicate', sourceSnapshotId: source.snapshotId, migration: null })
      const evaluated = await evaluateStoredSelections(request, token, copy.sessionId)
      expect(evaluated.selections).toEqual({ size: 'l' })
      expect(evaluated.evaluation.netPrice).toBe('150.00')
      const added = await finaliseOk(request, token, { id: copy.sessionId, expectedHash: evaluated.evaluation.hash, revision: evaluated.revision })
      expect(added.quoteLineId).not.toBe(source.quoteLineId)
      expect(added.snapshotId).not.toBe(source.snapshotId)

      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines).toHaveLength(2)
      const sourceLine = lines.find((line) => line.id === source.quoteLineId)
      const copyLine = lines.find((line) => line.id === added.quoteLineId)
      expect(sourceLine && lineField(sourceLine, 'name')).toBe('Pump for hall A')
      expect(sourceLine && lineField(sourceLine, 'comment')).toBe('Agreed with the buyer')
      expect(Number(sourceLine && lineField(sourceLine, 'discountPercent'))).toBe(10)
      expect(Number(sourceLine && lineField(sourceLine, 'unitPriceNet'))).toBe(100)

      expect(copyLine && lineField(copyLine, 'name')).toBe('QA PCFG 054 pump')
      expect((copyLine && lineField(copyLine, 'comment')) ?? null).toBeNull()
      expect(Number(copyLine && lineField(copyLine, 'discountPercent'))).toBe(0)
      expect(Number(copyLine && lineField(copyLine, 'discountAmount'))).toBe(0)
      expect(Number(copyLine && lineField(copyLine, 'taxRate'))).toBe(17.5)
      expect(Number(copyLine && lineField(copyLine, 'unitPriceNet'))).toBe(150)

      const session = await readJsonSafe<{ status: string; mode: string }>(
        await apiRequest(request, 'GET', `/api/product_configurator/sessions?id=${copy.sessionId}`, { token }),
      )
      expect(session).toMatchObject({ status: 'finalised', mode: 'duplicate' })
    } finally {
      await cleanup.run()
    }
  })
})
