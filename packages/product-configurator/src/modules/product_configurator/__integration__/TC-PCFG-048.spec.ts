import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createFrameFixture, finaliseFrame, openQuoteConfigurations, signInWithToken } from './helpers/configuratorUi'
import { createTaxRate, documentLines, lineField, type SalesLine } from './helpers/finalise'
import { Cleanup } from './helpers/sessions'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'

async function configuredLine(request: Parameters<typeof documentLines>[0], token: string, quoteId: string, lineId: string): Promise<SalesLine> {
  const line = (await documentLines(request, token, 'quote', quoteId)).find((entry) => entry.id === lineId)
  expect(line, 'the configured line is on the quote').toBeTruthy()
  return line as SalesLine
}

test.describe('TC-PCFG-048: edit a configured line from the Configurations tab', () => {
  test.use({ actionTimeout: 15_000 })

  test("name, comment, discount and tax are edited; quantity and price are shown read-only", async ({ page, request }) => {
    test.setTimeout(300_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '048')
      const taxRateId = await createTaxRate(request, token, cleanup, 17)
      expect(taxRateId).toBeTruthy()
      const added = await finaliseFrame(request, token, cleanup, fixture)

      await login(page, 'admin')
      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      const card = tab.getByTestId(`quote-configured-line-${added.snapshotId}`)
      await card.getByRole('button', { name: 'Edit line details' }).click()
      let dialog = page.getByTestId('line-details-dialog')
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      await card.getByRole('button', { name: 'Edit line details' }).click()
      dialog = page.getByTestId('line-details-dialog')
      const name = dialog.getByLabel('Name')
      await expect(name).toHaveValue(fixture.modelTitle, { timeout: 30_000 })
      const readOnly = dialog.getByTestId('line-details-read-only')
      await expect(readOnly).toContainText('€100.00')
      await expect(readOnly.locator('input')).toHaveCount(0)
      await expect(dialog.getByRole('textbox', { name: /Quantity/ })).toHaveCount(0)
      await expect(dialog.getByRole('spinbutton')).toHaveCount(0)

      await name.fill('Frame (site A)')
      await dialog.getByLabel('Comment').fill('Deliver after harvest')
      await dialog.getByRole('radio', { name: '%' }).click()
      await dialog.getByLabel('Discount in percent').fill('5')
      await dialog.getByRole('combobox').click()
      await page.getByRole('option', { name: /QA PCFG VAT .* \(17 %\)/ }).click()
      await dialog.press('Control+Enter')
      await expect(dialog).toBeHidden({ timeout: 30_000 })

      await expect
        .poll(async () => lineField(await configuredLine(request, token, fixture.quoteId, added.quoteLineId), 'name'), { timeout: 30_000 })
        .toBe('Frame (site A)')
      let line = await configuredLine(request, token, fixture.quoteId, added.quoteLineId)
      expect(lineField(line, 'comment')).toBe('Deliver after harvest')
      expect(Number(lineField(line, 'discountPercent'))).toBe(5)
      expect(Number(lineField(line, 'taxRate'))).toBe(17)
      expect(Number(lineField(line, 'unitPriceNet'))).toBe(100)
      expect(Number(lineField(line, 'quantity'))).toBe(1)
      await expect(card).toContainText('Frame (site A)')

      await card.getByRole('button', { name: 'Edit line details' }).click()
      dialog = page.getByTestId('line-details-dialog')
      await expect(dialog.getByLabel('Name')).toHaveValue('Frame (site A)', { timeout: 30_000 })
      await expect(dialog.getByLabel('Discount in percent')).toHaveValue('5')
      await dialog.getByRole('radio', { name: 'Amount (EUR)' }).click()
      await dialog.getByLabel('Discount amount (EUR)').fill('10')
      await dialog.getByTestId('line-details-save').click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })
      await expect
        .poll(async () => Number(lineField(await configuredLine(request, token, fixture.quoteId, added.quoteLineId), 'discountAmount')), { timeout: 30_000 })
        .toBe(10)
      line = await configuredLine(request, token, fixture.quoteId, added.quoteLineId)
      expect(Number(lineField(line, 'discountPercent'))).toBe(0)

      await card.getByRole('button', { name: 'Edit line details' }).click()
      dialog = page.getByTestId('line-details-dialog')
      await expect(dialog.getByLabel('Discount amount (EUR)')).toHaveValue('10', { timeout: 30_000 })
      await dialog.getByRole('radio', { name: 'None' }).click()
      await dialog.getByTestId('line-details-save').click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })
      await expect
        .poll(async () => Number(lineField(await configuredLine(request, token, fixture.quoteId, added.quoteLineId), 'discountAmount')), { timeout: 30_000 })
        .toBe(0)
    } finally {
      await cleanup.run()
    }
  })

  test('a sales rep without the sales settings feature opens the dialog, keeps the tax and saves the name', async ({ page, request }) => {
    test.setTimeout(300_000)
    const token = await getAuthToken(request, 'admin')
    const superadminToken = await getAuthToken(request, 'superadmin')
    const cleanup = new Cleanup()
    let rep: ScopedUser | null = null
    try {
      const fixture = await createFrameFixture(request, token, cleanup, '048r')
      const added = await finaliseFrame(request, token, cleanup, fixture)
      rep = await createUserWithFeatures(request, superadminToken, '048-rep', [
        'product_configurator.snapshots.view',
        'product_configurator.sessions.manage',
        'sales.quotes.view',
        'sales.quotes.manage',
      ], getTokenContext(token))
      const taxRateRequests: string[] = []
      page.on('request', (sent) => {
        if (sent.url().includes('/api/sales/tax-rates')) taxRateRequests.push(sent.url())
      })

      await signInWithToken(page, rep.token)
      const tab = await openQuoteConfigurations(page, fixture.quoteId)
      await tab.getByTestId(`quote-configured-line-${added.snapshotId}`).getByRole('button', { name: 'Edit line details' }).click()
      const dialog = page.getByTestId('line-details-dialog')
      const name = dialog.getByLabel('Name')
      await expect(name).toHaveValue(fixture.modelTitle, { timeout: 30_000 })
      await expect(dialog).toContainText('You cannot read the tax rates, so the current tax is kept.')
      await expect(dialog.getByRole('combobox')).toBeDisabled()
      await name.fill('Frame (rep)')
      await dialog.getByTestId('line-details-save').click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })
      await expect
        .poll(async () => lineField(await configuredLine(request, token, fixture.quoteId, added.quoteLineId), 'name'), { timeout: 30_000 })
        .toBe('Frame (rep)')
      expect(taxRateRequests).toEqual([])
    } finally {
      await deleteScopedUser(request, superadminToken, rep).catch(() => undefined)
      await cleanup.run()
    }
  })
})
