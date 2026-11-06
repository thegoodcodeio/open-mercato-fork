import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { QUOTE_TAB_ID, addToQuote, createFrameFixture, netPrice, openQuoteConfigurations, startConfiguration } from './helpers/configuratorUi'
import { configuredLines, documentLines, lineConfiguration } from './helpers/finalise'
import { Cleanup, cancelSession } from './helpers/sessions'

/** Prices: frame 100.00, cover 25.00 (see `frameDefinition`). */
test.describe('TC-PCFG-029: configure a product from the quote tab', () => {
  test.use({ actionTimeout: 15_000 })

  test('hidden fields appear with their condition, a refresh restores the session, forced values and blocking errors show, and Add to quote writes the line', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '029')
      await login(page, 'admin')

      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      const sessionId = await startConfiguration(page, tab, fixture.modelTitle)
      cleanup.add(() => cancelSession(request, token, sessionId))
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 90_000 })
      await expect(page.getByRole('heading', { name: fixture.modelTitle })).toBeVisible()
      await expect(page.getByTestId('configurator-feature-cover_color')).toHaveCount(0)

      await page.getByTestId('configurator-feature-cover').getByRole('switch').click()
      await expect(page.getByTestId('configurator-feature-cover_color')).toBeVisible({ timeout: 30_000 })
      await expect(netPrice(page)).toHaveText('€125.00')
      await page.getByTestId('configurator-option-cover_color-green').click()
      await expect(page.getByTestId('configurator-option-cover_color-green')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('configurator-summary')).not.toHaveAttribute('aria-busy', 'true')

      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(netPrice(page)).toHaveText('€125.00', { timeout: 60_000 })
      await expect(page.getByTestId('configurator-option-cover_color-green')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('configurator-feature-cover').getByRole('switch')).toHaveAttribute('aria-checked', 'true')

      const cover = page.getByTestId('configurator-feature-cover')
      await cover.getByRole('switch').click()
      await expect(page.getByTestId('configurator-feature-cover_color')).toHaveCount(0, { timeout: 30_000 })
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 30_000 })

      await page.getByTestId('configurator-option-size-l').click()
      await expect(cover.getByRole('switch')).toBeDisabled({ timeout: 30_000 })
      await expect(cover.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('configurator-option-cover_color-green')).toHaveAttribute('aria-checked', 'true')
      await expect(netPrice(page)).toHaveText('€125.00')
      await expect(cover).toContainText('Set automatically by Large frames come with a cover.')
      await expect(page.getByTestId('configurator-messages')).toContainText('Set automatically (Large frames come with a cover): Weather cover is Yes.')

      await page.getByTestId('configurator-option-size-s').click()
      await expect(cover.getByRole('switch')).toBeEnabled({ timeout: 30_000 })
      const length = page.getByTestId('configurator-feature-length').getByRole('textbox')
      await length.fill('9')
      await length.press('Enter')
      await expect(page.getByTestId('configurator-messages')).toContainText('Blocking: Small frames cannot be longer than 8 m.', { timeout: 30_000 })
      await expect(addToQuote(page)).toBeDisabled()

      await length.fill('5')
      await length.press('Enter')
      await expect(page.getByTestId('configurator-messages')).not.toContainText('Blocking:', { timeout: 30_000 })
      await expect(addToQuote(page)).toBeEnabled()
      await addToQuote(page).click()

      await page.waitForURL(new RegExp(`/backend/sales/quotes/${fixture.quoteId}\\?configuredLine=`), { timeout: 60_000, waitUntil: 'domcontentloaded' })
      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines).toHaveLength(1)
      const marker = lineConfiguration(lines[0])?.productConfigurator as { snapshotId: string } | undefined
      await page.locator(`[data-tab-id="${QUOTE_TAB_ID}"]`).click({ timeout: 90_000 })
      const reopened = page.getByTestId('quote-configurations-tab')
      const line = reopened.getByTestId(`quote-configured-line-${marker?.snapshotId}`)
      await expect(line).toHaveAttribute('data-highlighted', 'true')
      await expect(line).toContainText('€100.00')
      await expect(line).toContainText('Size: Small; Length: 5 m')
      await expect(reopened.getByTestId('quote-configurations-in-progress')).toHaveCount(0)
    } finally {
      await cleanup.run()
    }
  })
})
