import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { hashAuthToken } from '@open-mercato/core/modules/auth/lib/tokenHash'
import { addToQuote, createFrameFixture, netPrice, openOrderConfigurations, openQuoteConfigurations, startConfiguration } from './helpers/configuratorUi'
import { configuredLines, documentLines, readQuoteRecord } from './helpers/finalise'
import { Cleanup, cancelSession } from './helpers/sessions'

/** Public accept is same-origin only: the app checks `Origin` against `APP_URL` when it is set, else the request URL. */
function appOrigin(): string {
  const baseUrl = new URL(process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3000')
  if (baseUrl.hostname === '127.0.0.1') baseUrl.hostname = 'localhost'
  return baseUrl.origin
}

test.describe('TC-PCFG-044: quote -> configure -> add -> send -> accept -> the order tab links the snapshot', () => {
  test.use({ actionTimeout: 15_000 })

  test('a configuration added on the quote is on the order the customer accepted, with its details', async ({ page, request }) => {
    test.setTimeout(360_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '044')
      const customerEmail = `qa-pcfg-044-${Date.now()}@example.test`
      const updated = await apiRequest(request, 'PUT', '/api/sales/quotes', { token, data: { id: fixture.quoteId, metadata: { customerEmail } } })
      expect(updated.status(), `quote update: ${await updated.text()}`).toBe(200)

      await login(page, 'admin')
      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      const sessionId = await startConfiguration(page, tab, fixture.modelTitle)
      cleanup.add(() => cancelSession(request, token, sessionId))
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 90_000 })
      await page.getByTestId('configurator-option-size-l').click()
      await expect(netPrice(page)).toHaveText('€125.00', { timeout: 90_000 })
      await expect(addToQuote(page)).toBeEnabled({ timeout: 30_000 })
      await addToQuote(page).click()
      await page.waitForURL((url) => url.pathname.endsWith(`/sales/quotes/${fixture.quoteId}`), { timeout: 90_000, waitUntil: 'domcontentloaded' })
      const snapshotId = new URL(page.url()).searchParams.get('configuredLine') ?? ''
      expect(snapshotId, 'the quote page highlights the added configuration').toMatch(/^[0-9a-f-]{36}$/)
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toHaveLength(1)

      // Sending emails the raw acceptance token; the test stores a known one instead, as TC-SALES-039 does.
      const sent = await apiRequest(request, 'POST', '/api/sales/quotes/send', { token, data: { quoteId: fixture.quoteId, validForDays: 14 } })
      expect(sent.status(), `send: ${await sent.text()}`).toBe(200)
      expect((await readQuoteRecord(request, token, fixture.quoteId))?.status, 'the quote was sent').toBe('sent')
      const acceptanceToken = randomUUID()
      await withClient(async (client) => {
        const result = await client.query('update sales_quotes set acceptance_token = $2 where id = $1', [fixture.quoteId, hashAuthToken(acceptanceToken)])
        expect(result.rowCount).toBe(1)
      })
      const origin = appOrigin()
      const accepted = await request.post(`${new URL(process.env.BASE_URL || origin).origin}/api/sales/quotes/accept`, {
        data: { token: acceptanceToken },
        headers: { 'Content-Type': 'application/json', Origin: origin },
      })
      expect(accepted.status(), `accept: ${await accepted.text()}`).toBe(200)
      const orderId = (await readJsonSafe<{ orderId?: string }>(accepted))?.orderId ?? ''
      if (orderId) cleanup.add(() => apiRequest(request, 'DELETE', `/api/sales/orders?id=${encodeURIComponent(orderId)}`, { token }))
      expect(orderId).toMatch(/^[0-9a-f-]{36}$/)
      expect(configuredLines(await documentLines(request, token, 'order', orderId))).toHaveLength(1)

      const orderTab = await openOrderConfigurations(page, orderId)
      const card = orderTab.getByTestId(`order-configured-line-${snapshotId}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText('€125.00')
      await expect(card).toContainText('Size: Large')
      await card.getByRole('link', { name: 'Configuration details' }).click()
      await page.waitForURL((url) => url.pathname.endsWith(`/snapshots/${snapshotId}`) && url.searchParams.get('orderId') === orderId, {
        timeout: 90_000,
        waitUntil: 'domcontentloaded',
      })
      const detail = page.getByTestId('snapshot-detail')
      await expect(detail).toBeVisible({ timeout: 90_000 })
      await expect(detail).toContainText('On order')
      await expect(page.getByTestId('snapshot-net-price')).toContainText('€125.00')
      await expect(page.getByRole('link', { name: 'Back to order' })).toHaveAttribute('href', `/backend/sales/orders/${orderId}`)
    } finally {
      await cleanup.run()
    }
  })
})
