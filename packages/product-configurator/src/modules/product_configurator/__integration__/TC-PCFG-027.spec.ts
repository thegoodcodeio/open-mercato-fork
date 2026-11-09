import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { uniqueSuffix } from './helpers/fixtures'
import {
  Cleanup,
  createPrice,
  createQuote,
  createSalesChannel,
  createSinglePartModel,
  evaluateOk,
  openSessionId,
} from './helpers/sessions'

test.describe('TC-PCFG-027: the quote channel price wins over the base price', () => {
  test('a part with a channel row is priced from it on a quote of that channel, and from the base row otherwise', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()

    try {
      const model = await createSinglePartModel(request, token, cleanup, '027')
      const channelId = await createSalesChannel(request, token, cleanup, `QA PCFG 027 ${uniqueSuffix()}`)
      await createPrice(request, token, cleanup, { productId: model.partProductId, priceKindId: model.priceKindId, unitPriceNet: '72.50', channelId })

      const channelQuoteId = await createQuote(request, token, cleanup, { channelId })
      const channelSessionId = await openSessionId(request, token, cleanup, { quoteId: channelQuoteId, modelId: model.modelId })
      const channelPriced = await evaluateOk(request, token, { id: channelSessionId, revision: 0, selections: {} })
      expect(channelPriced.evaluation.bom).toEqual([expect.objectContaining({ bomId: 'part', unitPrice: '72.5', total: '72.50' })])
      expect(channelPriced.evaluation.netPrice).toBe('72.50')
      expect(channelPriced.evaluation.priceContext.channelId).toBe(channelId)

      const plainQuoteId = await createQuote(request, token, cleanup)
      const plainSessionId = await openSessionId(request, token, cleanup, { quoteId: plainQuoteId, modelId: model.modelId })
      const basePriced = await evaluateOk(request, token, { id: plainSessionId, revision: 0, selections: {} })
      expect(basePriced.evaluation.netPrice).toBe('100.00')
      expect(basePriced.evaluation.priceContext.channelId).toBeNull()
    } finally {
      await cleanup.run()
    }
  })
})
