import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { QUOTE_TAB_ID, createFrameFixture, finaliseFrame, quoteUrl } from './helpers/configuratorUi'
import { Cleanup } from './helpers/sessions'

test.describe('TC-PCFG-058: the quote shows the configured-lines notice below the totals', () => {
  test.use({ actionTimeout: 15_000 })

  test('the notice counts the configured lines, sits below the totals and opens the Configurations tab', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '058')
      await finaliseFrame(request, token, cleanup, fixture)
      await finaliseFrame(request, token, cleanup, fixture, { size: 'l' })

      await login(page, 'admin')
      await page.goto(quoteUrl(fixture.quoteId), { waitUntil: 'domcontentloaded' })
      const notice = page.getByTestId('quote-configured-lines-notice')
      await expect(notice).toBeVisible({ timeout: 90_000 })
      await expect(notice).toContainText('This quote has 2 configured lines. Edit their name, comment, discount and tax in the Configurations tab.')

      const totals = page.getByText('Totals', { exact: true }).first()
      const totalsBox = await totals.boundingBox()
      const noticeBox = await notice.boundingBox()
      expect(totalsBox && noticeBox && noticeBox.y > totalsBox.y, 'the notice renders below the totals').toBeTruthy()

      await notice.getByRole('button', { name: 'Configurations tab' }).click()
      await expect(page.locator(`[data-tab-id="${QUOTE_TAB_ID}"]`)).toHaveAttribute('data-active', 'true')
      await expect(page.getByTestId('quote-configurations-tab')).toBeVisible({ timeout: 30_000 })
    } finally {
      await cleanup.run()
    }
  })

  test('a quote without configured lines shows no notice', async ({ page, request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '058b')
      await login(page, 'admin')
      const snapshotsRead = page.waitForResponse(
        (response) => {
          const url = new URL(response.url())
          return url.pathname === '/api/product_configurator/snapshots' && url.searchParams.get('quoteId') === fixture.quoteId
        },
        { timeout: 90_000 },
      )
      await page.goto(quoteUrl(fixture.quoteId), { waitUntil: 'domcontentloaded' })
      expect((await snapshotsRead).status(), 'the notice read the quote configurations').toBe(200)
      await expect(page.locator(`[data-tab-id="${QUOTE_TAB_ID}"]`)).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('quote-configured-lines-notice')).toHaveCount(0)
    } finally {
      await cleanup.run()
    }
  })
})
