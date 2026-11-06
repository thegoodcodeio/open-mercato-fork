import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, createQuote } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finaliseOk, lineConfiguration } from './helpers/finalise'

// A marker that references a real *pending* snapshot is only reachable after a crash; that case is
// covered by commands/__tests__/interceptors.test.ts. Here the forged marker copies a real, finalised one.
test.describe('TC-PCFG-037: a forged configuration marker is rejected', () => {
  test('on a line insert, on an update of a plain line, and on inline quote and order create', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '037')
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const [configured] = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      const marker = lineConfiguration(configured)
      const forgedLine = {
        productId: fixture.productId,
        name: 'Forged pump',
        quantity: 1,
        currencyCode: 'EUR',
        unitPriceNet: 100,
        priceMode: 'net',
        configuration: marker,
      }
      const expectForged = async (label: string, response: Awaited<ReturnType<typeof apiRequest>>, createdPath?: string) => {
        if (createdPath && response.ok()) {
          const createdId = (await readJsonSafe<{ id?: string }>(response))?.id
          if (createdId) cleanup.add(() => apiRequest(request, 'DELETE', `${createdPath}?id=${encodeURIComponent(createdId)}`, { token }))
        }
        expect(response.status(), `${label}: ${await response.text()}`).toBe(422)
        expect((await readJsonSafe<{ code: string }>(response))?.code, label).toBe('configured_line_forged')
      }

      await expectForged('copied marker on a new quote line', await apiRequest(request, 'POST', '/api/sales/quote-lines', {
        token,
        data: { quoteId: fixture.quoteId, ...forgedLine },
      }))

      const otherQuoteId = await createQuote(request, token, cleanup)
      const plain = await apiRequest(request, 'POST', '/api/sales/quote-lines', {
        token,
        data: { quoteId: otherQuoteId, name: 'Plain line', quantity: 1, currencyCode: 'EUR', unitPriceNet: 10, priceMode: 'net' },
      })
      expect(plain.status(), await plain.text()).toBe(201)
      const plainId = (await readJsonSafe<{ id: string }>(plain))?.id
      await expectForged('marker added to a plain line', await apiRequest(request, 'PUT', '/api/sales/quote-lines', {
        token,
        data: { id: plainId, quoteId: otherQuoteId, currencyCode: 'EUR', quantity: 1, configuration: marker },
      }))

      await expectForged('inline line on quote create', await apiRequest(request, 'POST', '/api/sales/quotes', {
        token,
        data: { currencyCode: 'EUR', lines: [forgedLine] },
      }), '/api/sales/quotes')
      await expectForged('inline line on order create', await apiRequest(request, 'POST', '/api/sales/orders', {
        token,
        data: { currencyCode: 'EUR', lines: [forgedLine] },
      }), '/api/sales/orders')

      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId)).map((line) => line.id)).toEqual([result.quoteLineId])
      expect(configuredLines(await documentLines(request, token, 'quote', otherQuoteId))).toEqual([])
    } finally {
      await cleanup.run()
    }
  })
})
