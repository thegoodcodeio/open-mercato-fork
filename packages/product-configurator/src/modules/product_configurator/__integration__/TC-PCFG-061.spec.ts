import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { addToQuote, createFrameFixture, netPrice, openConfigurePage } from './helpers/configuratorUi'
import { Cleanup } from './helpers/sessions'

test.describe('TC-PCFG-061: invalid number text keeps Add to quote disabled', () => {
  test.use({ actionTimeout: 15_000 })

  test('range, step and non-numeric text show under the field, are never sent, and block the primary action', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '061')
      await login(page, 'admin')
      await openConfigurePage(page, request, token, cleanup, fixture)
      await expect(addToQuote(page)).toBeEnabled({ timeout: 30_000 })

      const sentLengths: unknown[] = []
      page.on('request', (request) => {
        if (!request.url().includes('/api/product_configurator/sessions/evaluate')) return
        const body = request.postDataJSON() as { selections?: Record<string, unknown> } | null
        sentLengths.push(body?.selections?.length)
      })

      const field = page.getByTestId('configurator-feature-length')
      const length = field.getByRole('textbox')
      for (const [text, message] of [
        ['9.3', 'Use steps of 0.5, starting from 1.'],
        ['abc', 'Enter a number.'],
        ['11', 'Use 10 or less.'],
        ['0.5', 'Use 1 or more.'],
      ]) {
        await length.fill(text)
        await expect(field).toContainText(message)
        await expect(length).toHaveAttribute('aria-invalid', 'true')
        await expect(addToQuote(page)).toBeDisabled()
        await length.press('Enter')
        await expect(addToQuote(page)).toBeDisabled()
      }
      await length.blur()
      await expect(addToQuote(page)).toBeDisabled()

      await length.fill('4.5')
      await length.press('Tab')
      await expect(netPrice(page)).toHaveText('€100.00', { timeout: 30_000 })
      await expect(addToQuote(page)).toBeEnabled({ timeout: 30_000 })
      expect(sentLengths).toEqual([4.5])
    } finally {
      await cleanup.run()
    }
  })
})
