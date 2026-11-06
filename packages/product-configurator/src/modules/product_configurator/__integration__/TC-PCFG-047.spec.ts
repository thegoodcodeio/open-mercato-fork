import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createFrameFixture, openQuoteConfigurations } from './helpers/configuratorUi'
import { finaliseOk } from './helpers/finalise'
import { Cleanup, evaluateOk, openSessionId } from './helpers/sessions'

test.describe('TC-PCFG-047: the configuration details page renders the snapshot read model', () => {
  test.use({ actionTimeout: 15_000 })

  test('choices, specification, bill of materials and net price, opened from the quote tab', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '047')
      const sessionId = await openSessionId(request, token, cleanup, { quoteId: fixture.quoteId, modelId: fixture.modelId })
      const evaluated = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: { cover: true, length: 3.5 } })
      expect(evaluated.evaluation.netPrice).toBe('125.00')
      const added = await finaliseOk(request, token, { id: sessionId, expectedHash: evaluated.evaluation.hash, revision: evaluated.revision })

      await login(page, 'admin')
      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      const line = tab.getByTestId(`quote-configured-line-${added.snapshotId}`)
      await expect(line).toContainText('On quote')
      await line.getByRole('link', { name: 'Configuration details' }).click()
      await page.waitForURL((url) => url.pathname.endsWith(`/snapshots/${added.snapshotId}`) && url.searchParams.get('quoteId') === fixture.quoteId, {
        timeout: 90_000,
        waitUntil: 'domcontentloaded',
      })

      const detail = page.getByTestId('snapshot-detail')
      await expect(detail).toBeVisible({ timeout: 90_000 })
      await expect(detail.getByRole('heading', { name: fixture.modelTitle })).toBeVisible()
      await expect(detail).toContainText('Model v1')
      await expect(detail).toContainText('On quote')

      const choices = page.getByTestId('snapshot-choices')
      for (const [label, value] of [
        ['Size', 'Small'],
        ['Weather cover', 'Yes'],
        ['Cover colour', 'Grey'],
        ['Length', '3.5 m'],
      ]) {
        await expect(choices.getByText(label, { exact: true })).toBeVisible()
        await expect(choices.getByText(value, { exact: true })).toBeVisible()
      }
      await expect(page.getByTestId('snapshot-specification')).toContainText('Galvanised steel')
      const bom = page.getByTestId('snapshot-bom')
      await expect(bom.getByRole('row')).toHaveCount(3)
      await expect(bom).toContainText(/QA-PCFG-047-FRAME-/i)
      await expect(bom).toContainText(/QA-PCFG-047-COVER-/i)
      await expect(bom).toContainText('€25.00')
      await expect(page.getByTestId('snapshot-net-price')).toContainText('€125.00')
      await expect(page.getByTestId('snapshot-summary')).toContainText('Size: Small')
    } finally {
      await cleanup.run()
    }
  })
})
