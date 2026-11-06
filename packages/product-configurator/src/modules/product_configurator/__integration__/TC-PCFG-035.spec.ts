import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import {
  configuredLines,
  createConfiguredSession,
  createTaxRate,
  documentLines,
  finaliseOk,
  lineConfiguration,
  lineField,
} from './helpers/finalise'

// The "an earlier interceptor's modifiedInput cannot bypass the guard" case needs a registered
// interceptor and is covered by commands/__tests__/interceptors.test.ts with the real runner.
test.describe('TC-PCFG-035: the configured quote line guard', () => {
  test('configured inputs, the marker and explicit amounts are locked; name, comment, discount and tax can change', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '035')
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const update = (change: Record<string, unknown>) =>
        apiRequest(request, 'PUT', '/api/sales/quote-lines', { token, data: { id: result.quoteLineId, quoteId: fixture.quoteId, currencyCode: 'EUR', quantity: 1, ...change } })

      const locked: Array<[string, Record<string, unknown>]> = [
        ['net price', { unitPriceNet: 50 }],
        ['quantity', { quantity: 2 }],
        ['quantity below the stored precision', { quantity: 1.00004 }],
        ['net price below the stored precision', { unitPriceNet: 100.00004 }],
        ['unit', { quantityUnit: 'm' }],
        ['product', { productId: fixture.partProductId }],
        ['marker', { configuration: {} }],
        ['marker contents', { configuration: { productConfigurator: { snapshotId: randomUUID() } } }],
        ['tax amount', { taxAmount: 5 }],
        ['total gross', { totalGrossAmount: 500 }],
      ]
      for (const [label, change] of locked) {
        const response = await update(change)
        expect(response.status(), `${label} change`).toBe(409)
        expect((await readJsonSafe<{ code: string }>(response))?.code, `${label} change`).toBe('configured_line_locked')
      }

      const taxRateId = await createTaxRate(request, token, cleanup, 10)
      const sameValues = await update({ name: 'Pump for site B', comment: 'Deliver in May', quantity: 1, unitPriceNet: 100.0, productId: fixture.productId })
      expect(sameValues.status(), await sameValues.text()).toBe(200)
      expect((await update({ discountPercent: 5 })).status()).toBe(200)
      expect((await update({ taxRateId, taxRate: 10 })).status()).toBe(200)

      const [line] = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lineField(line, 'name')).toBe('Pump for site B')
      expect(lineField(line, 'comment')).toBe('Deliver in May')
      expect(Number(lineField(line, 'unitPriceNet'))).toBe(100)
      expect(Number(lineField(line, 'quantity'))).toBe(1)
      expect(Number(lineField(line, 'discountPercent'))).toBe(5)
      expect(Number(lineField(line, 'taxRate'))).toBe(10)
      expect(Number(lineField(line, 'totalNetAmount'))).toBe(95)
      expect(Number(lineField(line, 'totalGrossAmount'))).toBe(104.5)
      expect(lineConfiguration(line)).toMatchObject({ productConfigurator: { snapshotId: result.snapshotId } })
    } finally {
      await cleanup.run()
    }
  })
})
