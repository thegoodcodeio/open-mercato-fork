import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { collectPageErrors, expectNoHydrationErrors, snapshotUrl } from './helpers/configuratorUi'
import { createConfiguredSession, finaliseOk } from './helpers/finalise'
import { Cleanup } from './helpers/sessions'

test.describe('TC-PCFG-045: hydration smoke test of the configuration details page', () => {
  test.use({ actionTimeout: 15_000 })

  test('the page mounts without hydration or runtime errors, opened from the quote and by id', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '045')
      const added = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })

      await login(page, 'admin')
      const errors = collectPageErrors(page)
      await page.goto(snapshotUrl(added.snapshotId, fixture.quoteId), { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('snapshot-net-price')).toContainText('€100.00', { timeout: 90_000 })
      await page.goto(`/backend/product_configurator/snapshots/${added.snapshotId}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('snapshot-bom')).toBeVisible({ timeout: 90_000 })
      expectNoHydrationErrors(errors)
    } finally {
      await cleanup.run()
    }
  })
})
