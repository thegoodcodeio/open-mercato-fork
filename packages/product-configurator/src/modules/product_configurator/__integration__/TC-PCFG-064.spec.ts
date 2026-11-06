import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createFrameFixture, finaliseFrame, orderUrl } from './helpers/configuratorUi'
import { configuredLines, convertQuote, documentLines } from './helpers/finalise'
import { Cleanup } from './helpers/sessions'

test.describe('TC-PCFG-064: the order items table shows the "Configured" column with a link to the snapshot', () => {
  test.use({ actionTimeout: 15_000 })

  test('a configured order line is marked and links to its configuration details opened from the order', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '064')
      const added = await finaliseFrame(request, token, cleanup, fixture, { cover: true })
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)
      const [orderLine] = configuredLines(await documentLines(request, token, 'order', orderId))
      expect(orderLine, 'the order carries the configured line').toBeTruthy()

      await login(page, 'admin')
      await page.goto(orderUrl(orderId), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('columnheader', { name: 'Configured' })).toBeVisible({ timeout: 90_000 })
      const cell = page.getByTestId(`order-item-configured-${orderLine.id}`)
      await expect(cell).toBeVisible({ timeout: 30_000 })
      await expect(cell).toContainText('Configured')
      const link = cell.getByRole('link', { name: /Configuration details of/ })
      await expect(link).toHaveAttribute('href', `/backend/product_configurator/snapshots/${added.snapshotId}?orderId=${orderId}`)

      await link.click()
      await page.waitForURL((url) => url.pathname.endsWith(`/snapshots/${added.snapshotId}`) && url.searchParams.get('orderId') === orderId, {
        timeout: 90_000,
        waitUntil: 'domcontentloaded',
      })
      const detail = page.getByTestId('snapshot-detail')
      await expect(detail).toBeVisible({ timeout: 90_000 })
      await expect(detail).toContainText('On order')
      await expect(page.getByTestId('snapshot-net-price')).toContainText('€125.00')
      await expect(page.getByTestId('snapshot-net-price')).toContainText('Before discounts and tax.')
      await expect(detail).not.toContainText('added to the quote')
    } finally {
      await cleanup.run()
    }
  })
})
