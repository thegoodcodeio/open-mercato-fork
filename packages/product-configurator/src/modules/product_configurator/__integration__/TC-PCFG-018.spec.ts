import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { addToQuote, createFrameFixture, frameDefinition, netPrice, openConfigurePage } from './helpers/configuratorUi'
import { Cleanup } from './helpers/sessions'

/** `frameDefinition` plus a "Load ratio" formula = 10 / (length - 2), which cannot be computed at 2 m. */
function ratioDefinition(skus: { frame: string; cover: string }): Record<string, unknown> {
  const base = frameDefinition(skus)
  const features = (base.features as Array<Record<string, unknown>>).map((feature) => (feature.key === 'length' ? { ...feature, default: 3 } : feature))
  return {
    ...base,
    features,
    formulas: [
      {
        key: 'ratio',
        label: 'Load ratio',
        expr: {
          kind: 'op',
          op: '/',
          left: { kind: 'const', value: 10 },
          right: { kind: 'op', op: '-', left: { kind: 'feature', featureKey: 'length' }, right: { kind: 'const', value: 2 } },
        },
        decimals: 2,
      },
    ],
  }
}

test.describe('TC-PCFG-018: deterministic errors, keyboard and live region of the configurator', () => {
  test.use({ actionTimeout: 15_000 })

  test('a missing catalog price names the part and offers no Retry', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '018a')
      await login(page, 'admin')
      await openConfigurePage(page, request, token, cleanup, fixture)
      await expect(netPrice(page)).toHaveText('€100.00')

      const removed = await apiRequest(request, 'DELETE', `/api/catalog/prices?id=${encodeURIComponent(fixture.framePriceId)}`, { token })
      expect(removed.ok(), `DELETE price failed: ${removed.status()}`).toBeTruthy()
      await page.getByTestId('configurator-option-size-l').click()

      const failure = page.getByTestId('configurator-failure')
      await expect(failure).toContainText(/No catalog price for QA-PCFG-018a-FRAME-/i, { timeout: 30_000 })
      await expect(failure).toContainText('An admin needs to add the price')
      await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
      await expect(netPrice(page)).toHaveText('-')
      await expect(addToQuote(page)).toBeDisabled()
    } finally {
      await cleanup.run()
    }
  })

  test('a formula that cannot be computed asks for an admin fix and keeps the choices', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '018b', { definition: ratioDefinition })
      await login(page, 'admin')
      await openConfigurePage(page, request, token, cleanup, fixture)

      const length = page.getByTestId('configurator-feature-length').getByRole('textbox')
      await length.fill('2')
      await length.press('Enter')
      const failure = page.getByTestId('configurator-failure')
      await expect(failure).toHaveText('This model needs a fix by an admin: the formula Load ratio cannot be computed.', { timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
      await expect(addToQuote(page)).toBeDisabled()
      await expect(length).toHaveValue('2')

      await length.fill('4')
      await length.press('Enter')
      await expect(failure).toHaveCount(0, { timeout: 30_000 })
      await expect(netPrice(page)).toHaveText('€100.00')
      await expect(addToQuote(page)).toBeEnabled()
    } finally {
      await cleanup.run()
    }
  })

  test('arrow keys change a choice, one polite announcement follows each evaluation, and "Go to" focuses the field', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '018c')
      await login(page, 'admin')
      await openConfigurePage(page, request, token, cleanup, fixture)
      const live = page.getByTestId('configurator-workspace').locator('[aria-live="polite"]')
      await expect(live).toHaveText('Net price €100.00. 0 messages, 0 blocking.', { timeout: 30_000 })

      // Radix roving focus moves focus in a timeout and checks the item only while the arrow key is still down,
      // so the key is held like a real key press instead of an instant press().
      await page.getByTestId('configurator-option-size-s').focus()
      await page.keyboard.down('ArrowRight')
      await expect(page.getByTestId('configurator-option-size-l')).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.up('ArrowRight')
      await expect(page.getByTestId('configurator-option-size-l')).toBeFocused()
      await expect(live).toHaveText('Net price €125.00. 1 messages, 0 blocking.', { timeout: 30_000 })

      await page.keyboard.down('ArrowLeft')
      await expect(page.getByTestId('configurator-option-size-s')).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.up('ArrowLeft')
      await expect(live).toHaveText('Net price €100.00. 0 messages, 0 blocking.', { timeout: 30_000 })

      const length = page.getByTestId('configurator-feature-length').getByRole('textbox')
      await length.fill('9')
      await length.press('Enter')
      await expect(live).toHaveText('Net price €100.00. 1 messages, 1 blocking.', { timeout: 30_000 })
      await page.getByTestId('configurator-option-size-s').focus()
      await page.getByTestId('configurator-messages').getByRole('button', { name: 'Go to Length' }).click()
      await expect(length).toBeFocused()
    } finally {
      await cleanup.run()
    }
  })
})
