import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { collectPageErrors, createFrameFixture, expectNoHydrationErrors, finaliseFrame, openOrderConfigurations } from './helpers/configuratorUi'
import { convertQuote } from './helpers/finalise'
import { Cleanup } from './helpers/sessions'

test.describe('TC-PCFG-046: hydration smoke test of the order Configurations tab', () => {
  test.use({ actionTimeout: 15_000 })

  test('the order tab, the Configured column and the details opened from the order mount without hydration or runtime errors', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '046')
      const added = await finaliseFrame(request, token, cleanup, fixture)
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)

      await login(page, 'admin')
      const errors = collectPageErrors(page)
      const tab = await openOrderConfigurations(page, orderId)
      const card = tab.getByTestId(`order-configured-line-${added.snapshotId}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText('€100.00')
      await expect(tab.getByRole('button')).toHaveCount(0)

      await card.getByRole('link', { name: 'Configuration details' }).click()
      await page.waitForURL((url) => url.searchParams.get('orderId') === orderId, { timeout: 90_000, waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('snapshot-detail')).toBeVisible({ timeout: 90_000 })

      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('snapshot-detail')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('snapshot-bom').getByRole('row')).toHaveCount(2)

      expectNoHydrationErrors(errors)
    } finally {
      await cleanup.run()
    }
  })
})
