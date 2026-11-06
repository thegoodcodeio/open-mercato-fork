import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  collectPageErrors,
  configureUrl,
  createFrameFixture,
  expectNoHydrationErrors,
  netPrice,
  openQuoteConfigurations,
  startConfiguration,
} from './helpers/configuratorUi'
import { Cleanup, cancelSession } from './helpers/sessions'

test.describe('TC-PCFG-019: hydration smoke test of the configure page and the quote tab', () => {
  test.use({ actionTimeout: 15_000 })

  test('the quote Configurations tab and the configure page mount without hydration or runtime errors', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '019')
      await login(page, 'admin')
      const errors = collectPageErrors(page)

      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      await expect(tab.getByTestId('quote-configure-product')).toBeVisible()
      const sessionId = await startConfiguration(page, tab, fixture.modelTitle)
      cleanup.add(() => cancelSession(request, token, sessionId))
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 90_000 })

      await page.goto(configureUrl(sessionId), { waitUntil: 'domcontentloaded' })
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 90_000 })
      await expect(page.getByTestId('configurator-feature-size')).toBeVisible()

      const reopened = await openQuoteConfigurations(page, fixture.quoteId)
      await expect(reopened.getByTestId(`quote-session-${sessionId}`)).toBeVisible()

      expectNoHydrationErrors(errors)
    } finally {
      await cleanup.run()
    }
  })
})
