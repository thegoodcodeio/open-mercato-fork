import { expect, test, type APIRequestContext } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { addToQuote, createFrameFixture, netPrice, openConfigurePage } from './helpers/configuratorUi'
import { Cleanup, evaluateOk, readSession } from './helpers/sessions'

async function changeInAnotherWindow(request: APIRequestContext, token: string, sessionId: string, selections: Record<string, unknown>): Promise<number> {
  const current = await readJsonSafe<{ revision: number }>(await readSession(request, token, `id=${sessionId}`))
  const evaluated = await evaluateOk(request, token, { id: sessionId, revision: current?.revision ?? 0, selections })
  return evaluated.revision
}

/** UI side of TC-PCFG-051. Prices: frame 100.00, cover 25.00; Large forces the cover. */
test.describe('TC-PCFG-051 (UI): a session changed in another window', () => {
  test.use({ actionTimeout: 15_000 })

  test('the refused choices are listed next to the current ones, then applied again or dropped', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '051ui')
      await login(page, 'admin')
      const sessionId = await openConfigurePage(page, request, token, cleanup, fixture)
      await expect(netPrice(page)).toHaveText('€100.00')

      await changeInAnotherWindow(request, token, sessionId, { size: 'l' })
      await page.getByTestId('configurator-feature-cover').getByRole('switch').click()
      const panel = page.getByTestId('configurator-session-changed')
      await expect(panel).toContainText('This configuration was changed in another window or by a colleague. Your choices were not applied.', { timeout: 30_000 })
      const sizeRow = panel.getByRole('row', { name: /Size/ })
      await expect(sizeRow).toContainText('Small')
      await expect(sizeRow).toContainText('Large')
      await expect(panel.getByRole('row', { name: /Weather cover/ })).toHaveCount(0)
      await expect(addToQuote(page)).toBeDisabled()

      await panel.getByRole('button', { name: 'Apply my choices' }).click()
      await expect(panel).toHaveCount(0)
      await expect(netPrice(page)).toHaveText('€125.00', { timeout: 30_000 })
      await expect(page.getByTestId('configurator-option-size-s')).toHaveAttribute('aria-checked', 'true')
      const applied = await readJsonSafe<{ selections: Record<string, unknown> }>(await readSession(request, token, `id=${sessionId}`))
      expect(applied?.selections).toEqual({ cover: true })

      await changeInAnotherWindow(request, token, sessionId, { size: 'l' })
      await page.getByTestId('configurator-option-cover_color-green').click()
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await panel.getByRole('button', { name: 'Keep current' }).click()
      await expect(panel).toHaveCount(0)
      await expect(page.getByTestId('configurator-option-size-l')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('configurator-option-cover_color-grey')).toHaveAttribute('aria-checked', 'true')
      await expect(netPrice(page)).toHaveText('€125.00')
      await expect(addToQuote(page)).toBeEnabled()

      await page.getByTestId('configurator-option-cover_color-green').click()
      await expect(page.getByTestId('configurator-option-cover_color-green')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('configurator-summary')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
      await expect(panel).toHaveCount(0)
      const kept = await readJsonSafe<{ selections: Record<string, unknown> }>(await readSession(request, token, `id=${sessionId}`))
      expect(kept?.selections).toEqual({ size: 'l', cover_color: 'green' })
    } finally {
      await cleanup.run()
    }
  })
})
