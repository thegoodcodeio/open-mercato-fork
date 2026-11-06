import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { addToQuote, createFrameFixture, finaliseFrame, netPrice, openQuoteConfigurations, publishChangedDraft } from './helpers/configuratorUi'
import { configuredLines, documentLines, lineConfiguration } from './helpers/finalise'
import { Cleanup, cancelSession } from './helpers/sessions'

type Feature = { key: string; options?: Array<{ value: string }> }

/** Version 2 of the frame model no longer offers a green cover. */
function withoutGreenCover(definition: Record<string, unknown>): Record<string, unknown> {
  const features = (definition.features as Feature[]).map((feature) =>
    feature.key === 'cover_color' ? { ...feature, options: (feature.options ?? []).filter((option) => option.value !== 'green') } : feature,
  )
  return { ...definition, features }
}

test.describe('TC-PCFG-057: "Add another identical" across model versions shows the copy review', () => {
  test.use({ actionTimeout: 15_000 })

  test('the reset choice is marked in the workspace and reviewed before the copy is added as a new line', async ({ page, request }) => {
    test.setTimeout(300_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '057')
      const source = await finaliseFrame(request, token, cleanup, fixture, { cover: true, cover_color: 'green' })
      await publishChangedDraft(request, token, fixture.modelId, withoutGreenCover)

      await login(page, 'admin')
      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      const opened = page.waitForURL(/\/backend\/product_configurator\/configure\/[0-9a-f-]{36}/, { timeout: 90_000, waitUntil: 'domcontentloaded' })
      opened.catch(() => undefined)
      await tab.getByTestId(`quote-configured-line-${source.snapshotId}`).getByRole('button', { name: 'Add another identical' }).click()
      await opened
      const sessionId = /configure\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? ''
      cleanup.add(() => cancelSession(request, token, sessionId))

      await expect(page.getByRole('heading', { name: `Copy of: ${fixture.modelTitle}` })).toBeVisible({ timeout: 90_000 })
      await expect(page.getByText('copied from model v1, now v2')).toBeVisible()
      await expect(page.getByTestId('configurator-migration-notice')).toContainText('Model v2 changed 1 of the copied choices.')
      await expect(netPrice(page)).toHaveText('€125.00', { timeout: 90_000 })
      await expect(page.getByTestId('configurator-migration-cover_color')).toContainText('Reset to Grey: Green was removed in v2.')

      await addToQuote(page).click()
      const review = page.getByTestId('configurator-copy-review')
      await expect(review).toBeVisible()
      const row = review.getByTestId('configurator-copy-review-cover_color')
      await expect(row).toContainText('Cover colour')
      await expect(row).toContainText('Green')
      await expect(row).toContainText('Grey')
      await expect(review).toContainText('New price €125.00')
      const add = review.getByTestId('configurator-copy-review-add')
      await expect(add).toBeDisabled()

      await review.getByRole('button', { name: 'Edit choices' }).click()
      await expect(review).toBeHidden()
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toHaveLength(1)

      await addToQuote(page).click()
      await review.getByRole('checkbox', { name: 'I reviewed the changed choices' }).click()
      await review.getByTestId('configurator-copy-review-add').click()
      await page.waitForURL((url) => url.pathname.endsWith(`/sales/quotes/${fixture.quoteId}`), { timeout: 90_000, waitUntil: 'domcontentloaded' })

      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines).toHaveLength(2)
      const sourceLine = lines.find((line) => line.id === source.quoteLineId)
      expect(lineConfiguration(sourceLine ?? { id: '' })?.productConfigurator).toMatchObject({ snapshotId: source.snapshotId })
      const copyLine = lines.find((line) => line.id !== source.quoteLineId)
      expect(copyLine, 'the copy is a separate line').toBeTruthy()
    } finally {
      await cleanup.run()
    }
  })
})
