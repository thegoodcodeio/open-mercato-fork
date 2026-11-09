import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup, readSession } from './helpers/sessions'
import {
  configuredLines,
  createConfiguredSession,
  createTaxRate,
  documentLines,
  finaliseOk,
  lineConfiguration,
  lineField,
} from './helpers/finalise'

test.describe('TC-PCFG-030: finalise writes a configured quote line', () => {
  test('the line carries the bound product, the configured net price, the product tax rate and the marker; sales computes gross', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const taxRateId = await createTaxRate(request, token, cleanup, 17.5)
      const fixture = await createConfiguredSession(request, token, cleanup, '030', { taxRateId, title: 'QA PCFG configured pump' })
      expect(fixture.evaluation.netPrice).toBe('100.00')

      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(result).toMatchObject({ hash: fixture.evaluation.hash, replay: false, outcome: 'added' })

      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines).toHaveLength(1)
      const [line] = lines
      expect(line.id).toBe(result.quoteLineId)
      expect(lineField(line, 'productId')).toBe(fixture.productId)
      expect(lineField(line, 'productVariantId') ?? null).toBeNull()
      expect(lineField(line, 'name')).toBe('QA PCFG configured pump')
      expect(lineField(line, 'description')).toBe(fixture.evaluation.summary)
      expect(Number(lineField(line, 'quantity'))).toBe(1)
      expect(Number(lineField(line, 'unitPriceNet'))).toBe(100)
      // Sales lines keep the resolved rate, not taxRateId; an unusual 17.5 % rate can only come from the bound product.
      expect(Number(lineField(line, 'taxRate'))).toBe(17.5)
      expect(Number(lineField(line, 'totalNetAmount'))).toBe(100)
      expect(Number(lineField(line, 'totalGrossAmount'))).toBe(117.5)
      expect(lineConfiguration(line)).toEqual({
        productConfigurator: {
          snapshotId: result.snapshotId,
          modelVersionId: expect.any(String),
          hash: fixture.evaluation.hash,
          summary: fixture.evaluation.summary,
        },
      })

      const session = await readJsonSafe<{ status: string }>(await readSession(request, token, `id=${fixture.sessionId}`))
      expect(session?.status).toBe('finalised')
    } finally {
      await cleanup.run()
    }
  })

  test('a model bound to a product without SKU is finalised the same way, without a tax rate', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '030B', { withoutSku: true })
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines).toHaveLength(1)
      const [line] = lines
      expect(line.id).toBe(result.quoteLineId)
      expect(lineField(line, 'productId')).toBe(fixture.productId)
      expect(Number(lineField(line, 'unitPriceNet'))).toBe(100)
      expect(Number(lineField(line, 'totalGrossAmount'))).toBe(100)
    } finally {
      await cleanup.run()
    }
  })
})
