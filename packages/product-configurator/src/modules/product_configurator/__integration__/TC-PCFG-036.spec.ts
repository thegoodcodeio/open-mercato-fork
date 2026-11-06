import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import { configuredLines, convertQuote, createConfiguredSession, documentLines, finaliseOk, lineField } from './helpers/finalise'

test.describe('TC-PCFG-036: the guard protects configured order lines after conversion', () => {
  test('the order line keeps its configured price; a name change passes', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '036')
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)
      const [orderLine] = configuredLines(await documentLines(request, token, 'order', orderId))
      expect(orderLine.id).toBe(result.quoteLineId)

      const update = (change: Record<string, unknown>) =>
        apiRequest(request, 'PUT', '/api/sales/order-lines', { token, data: { id: orderLine.id, orderId, currencyCode: 'EUR', quantity: 1, ...change } })
      for (const change of [{ unitPriceNet: 1 }, { quantity: 3 }, { configuration: {} }, { totalGrossAmount: 1 }]) {
        const response = await update(change)
        expect(response.status(), JSON.stringify(change)).toBe(409)
        expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('configured_line_locked')
      }
      expect((await update({ name: 'Pump, ordered' })).status()).toBe(200)

      const [after] = configuredLines(await documentLines(request, token, 'order', orderId))
      expect(lineField(after, 'name')).toBe('Pump, ordered')
      expect(Number(lineField(after, 'unitPriceNet'))).toBe(100)
    } finally {
      await cleanup.run()
    }
  })
})
