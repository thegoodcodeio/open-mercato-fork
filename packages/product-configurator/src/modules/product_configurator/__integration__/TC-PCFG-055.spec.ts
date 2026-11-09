import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg, createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './helpers/fixtures'
import { Cleanup, createQuote } from './helpers/sessions'
import {
  configuredLines,
  createConfiguredSession,
  createTaxRate,
  documentLines,
  finaliseOk,
  lineConfiguration,
  lineField,
  readQuoteRecord,
  type FinaliseBody,
  type SalesLine,
} from './helpers/finalise'
import { updateLine } from './helpers/copies'
import { createForeignTenant, createUserWithFeatures, deleteForeignTenant, deleteScopedUser, type ForeignTenant, type ScopedUser } from './helpers/users'

const LINE_UPDATE_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.manage', 'sales.quotes.view']

function quoteLockToken(quote: Record<string, unknown> | null): string {
  return String(quote?.updated_at ?? quote?.updatedAt ?? '')
}

async function readConfiguredLine(request: APIRequestContext, token: string, quoteId: string, lineId: string): Promise<SalesLine> {
  const line = configuredLines(await documentLines(request, token, 'quote', quoteId)).find((entry) => entry.id === lineId)
  expect(line, 'the configured line is still on the quote').toBeTruthy()
  return line as SalesLine
}

/** The configured inputs an edit never changes: product, currency, quantity, net price and the configuration marker. */
function expectConfiguredInputs(line: SalesLine, productId: string, finalised: FinaliseBody): void {
  expect(lineField(line, 'productId')).toBe(productId)
  expect(lineField(line, 'currencyCode')).toBe('EUR')
  expect(Number(lineField(line, 'unitPriceNet'))).toBe(100)
  expect(Number(lineField(line, 'quantity'))).toBe(1)
  expect(lineConfiguration(line)?.productConfigurator).toMatchObject({ snapshotId: finalised.snapshotId, hash: finalised.hash })
}

function commercialFields(line: SalesLine): Record<string, unknown> {
  return {
    name: lineField(line, 'name'),
    comment: lineField(line, 'comment') ?? null,
    discountPercent: Number(lineField(line, 'discountPercent')),
    discountAmount: Number(lineField(line, 'discountAmount')),
    taxRate: Number(lineField(line, 'taxRate')),
    totalGrossAmount: Number(lineField(line, 'totalGrossAmount')),
  }
}

test.describe('TC-PCFG-055: POST /lines/update edits the commercial fields of a configured line', () => {
  test('name, comment, discount (percent, amount, none) and tax change through sales; configured inputs stay; a plain line is refused', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '055')
      const finalised = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const { quoteLineId } = finalised
      let lockToken = quoteLockToken(await readQuoteRecord(request, token, fixture.quoteId))
      expect(lockToken, 'the quote has an updatedAt lock token').toBeTruthy()

      async function edit(change: Record<string, unknown>): Promise<SalesLine> {
        const response = await updateLine(request, token, { quoteId: fixture.quoteId, lineId: quoteLineId, ...change }, lockToken)
        expect(response.status(), `${JSON.stringify(change)}: ${await response.text()}`).toBe(200)
        const body = await readJsonSafe<{ lineId: string; updatedAt: string | null }>(response)
        expect(body?.lineId).toBe(quoteLineId)
        expect(body?.updatedAt).toBeTruthy()
        lockToken = body?.updatedAt ?? ''
        const line = await readConfiguredLine(request, token, fixture.quoteId, quoteLineId)
        expectConfiguredInputs(line, fixture.productId, finalised)
        return line
      }

      const named = await edit({ name: 'Pump for hall B', comment: 'Delivery in March' })
      expect(lineField(named, 'name')).toBe('Pump for hall B')
      expect(lineField(named, 'comment')).toBe('Delivery in March')

      const percent = await edit({ discount: { mode: 'percent', value: 5 } })
      expect(Number(lineField(percent, 'discountPercent'))).toBe(5)
      expect(Number(lineField(percent, 'totalNetAmount'))).toBe(95)

      const amount = await edit({ discount: { mode: 'amount', value: 12.5 } })
      expect(Number(lineField(amount, 'discountPercent'))).toBe(0)
      expect(Number(lineField(amount, 'totalNetAmount'))).toBe(87.5)

      const none = await edit({ discount: { mode: 'none' } })
      expect(Number(lineField(none, 'discountPercent'))).toBe(0)
      expect(Number(lineField(none, 'discountAmount'))).toBe(0)
      expect(Number(lineField(none, 'totalNetAmount'))).toBe(100)

      const taxRateId = await createTaxRate(request, token, cleanup, 23)
      const taxed = await edit({ taxRateId })
      expect(Number(lineField(taxed, 'taxRate'))).toBe(23)
      expect(Number(lineField(taxed, 'totalGrossAmount'))).toBe(123)
      expect(Number(lineField(taxed, 'unitPriceGross'))).toBe(123)

      const untaxed = await edit({ taxRateId: null, comment: null })
      expect(Number(lineField(untaxed, 'taxRate'))).toBe(0)
      expect(Number(lineField(untaxed, 'totalGrossAmount'))).toBe(100)
      expect(lineField(untaxed, 'comment') ?? '').toBe('')

      const stale = await updateLine(request, token, { quoteId: fixture.quoteId, lineId: quoteLineId, name: 'Stale' }, '2020-01-01T00:00:00.000Z')
      expect(stale.status()).toBe(409)

      const plain = await apiRequest(request, 'POST', '/api/sales/quote-lines', {
        token,
        data: { quoteId: fixture.quoteId, name: 'Plain line', quantity: 1, currencyCode: 'EUR', unitPriceNet: 10, priceMode: 'net' },
      })
      expect(plain.status(), await plain.text()).toBe(201)
      const plainId = (await readJsonSafe<{ id: string }>(plain))?.id
      const refused = await updateLine(request, token, { quoteId: fixture.quoteId, lineId: plainId, name: 'Renamed' })
      expect(refused.status()).toBe(422)
      expect((await readJsonSafe<{ code: string }>(refused))?.code).toBe('not_a_configured_line')

      const missing = await updateLine(request, token, { quoteId: fixture.quoteId, lineId: fixture.sessionId, name: 'Renamed' })
      expect(missing.status()).toBe(404)
    } finally {
      await cleanup.run()
    }
  })

  test('users without configurator sessions or quote edit rights get 403; quote, line and tax rate ids of another organization or tenant are refused; the line stays unchanged', async ({
    request,
  }) => {
    test.setTimeout(240_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const token = await getAuthToken(request, 'admin')
    const home = getTokenContext(token)
    const cleanup = new Cleanup()
    const users: Array<ScopedUser | null> = []
    let otherOrganizationId: string | null = null
    let foreignTenant: ForeignTenant | null = null
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '055B')
      const finalised = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const lineId = finalised.quoteLineId
      const ownTaxRateId = await createTaxRate(request, token, cleanup, 23)
      const prepared = await updateLine(
        request,
        token,
        { quoteId: fixture.quoteId, lineId, name: 'Pump for hall C', comment: 'Keep this', discount: { mode: 'percent', value: 5 }, taxRateId: ownTaxRateId },
        quoteLockToken(await readQuoteRecord(request, token, fixture.quoteId)),
      )
      expect(prepared.status(), await prepared.text()).toBe(200)
      const lockToken = (await readJsonSafe<{ updatedAt: string | null }>(prepared))?.updatedAt ?? ''
      expect(lockToken, 'the edit answers the next lock token').toBeTruthy()
      const before = commercialFields(await readConfiguredLine(request, token, fixture.quoteId, lineId))
      expect(before).toMatchObject({ name: 'Pump for hall C', comment: 'Keep this', discountPercent: 5, taxRate: 23 })
      const change = { name: 'Hijacked', comment: 'Hijacked', discount: { mode: 'amount', value: 50 } }

      const noQuoteEdit = await createUserWithFeatures(request, superadminToken, '055-no-quote-edit', ['product_configurator.sessions.manage', 'sales.quotes.view'], home)
      users.push(noQuoteEdit)
      const noSessions = await createUserWithFeatures(request, superadminToken, '055-no-sessions', ['sales.quotes.manage', 'sales.quotes.view'], home)
      users.push(noSessions)
      for (const [label, user] of [['without sales.quotes.manage', noQuoteEdit], ['without sessions.manage', noSessions]] as const) {
        const response = await updateLine(request, user.token, { quoteId: fixture.quoteId, lineId, ...change }, lockToken)
        expect(response.status(), `${label}: ${await response.text()}`).toBe(403)
      }

      otherOrganizationId = await createOrganizationFixture(request, superadminToken, { name: `QA PCFG 055 ${uniqueSuffix()}`, tenantId: home.tenantId })
      const otherOrg = { selectedOrgId: otherOrganizationId }
      const otherOrgTaxRateId = await createTaxRate(request, superadminToken, cleanup, 8, otherOrg)
      const otherOrgQuoteId = await createQuote(request, superadminToken, cleanup, otherOrg)
      const otherOrgLine = await apiRequestWithSelectedOrg(request, 'POST', '/api/sales/quote-lines', {
        token: superadminToken,
        selectedOrgId: otherOrganizationId,
        data: { quoteId: otherOrgQuoteId, name: 'Other organization line', quantity: 1, currencyCode: 'EUR', unitPriceNet: 10, priceMode: 'net' },
      })
      expect(otherOrgLine.status(), await otherOrgLine.text()).toBe(201)
      const otherOrgLineId = expectId((await readJsonSafe<{ id?: string }>(otherOrgLine))?.id, 'other organization line id')

      foreignTenant = await createForeignTenant(request, superadminToken, '055')
      const foreignUser = await createUserWithFeatures(request, superadminToken, '055-foreign', [...LINE_UPDATE_FEATURES, 'sales.settings.manage'], foreignTenant)
      users.push(foreignUser)
      const foreignTaxRateId = await createTaxRate(request, foreignUser.token, cleanup, 7)
      const foreignQuoteId = await createQuote(request, foreignUser.token, cleanup)
      const foreignLine = await apiRequest(request, 'POST', '/api/sales/quote-lines', {
        token: foreignUser.token,
        data: { quoteId: foreignQuoteId, name: 'Other tenant line', quantity: 1, currencyCode: 'EUR', unitPriceNet: 10, priceMode: 'net' },
      })
      expect(foreignLine.status(), await foreignLine.text()).toBe(201)
      const foreignLineId = expectId((await readJsonSafe<{ id?: string }>(foreignLine))?.id, 'other tenant line id')

      const refusals: Array<[string, () => Promise<APIResponse>, string]> = [
        ['our quote from another organization', () => updateLine(request, superadminToken, { quoteId: fixture.quoteId, lineId, ...change }, lockToken, otherOrg), 'quote_not_found'],
        ['our quote from another tenant', () => updateLine(request, foreignUser.token, { quoteId: fixture.quoteId, lineId, ...change }, lockToken), 'quote_not_found'],
        ['a quote of another organization', () => updateLine(request, token, { quoteId: otherOrgQuoteId, lineId, ...change }, lockToken), 'quote_not_found'],
        ['a line of another organization', () => updateLine(request, token, { quoteId: fixture.quoteId, lineId: otherOrgLineId, ...change }, lockToken), 'line_not_found'],
        ['a line of another tenant', () => updateLine(request, token, { quoteId: fixture.quoteId, lineId: foreignLineId, ...change }, lockToken), 'line_not_found'],
        [
          'a tax rate of another organization',
          () => updateLine(request, token, { quoteId: fixture.quoteId, lineId, ...change, taxRateId: otherOrgTaxRateId }, lockToken),
          'tax_rate_not_found',
        ],
        [
          'a tax rate of another tenant',
          () => updateLine(request, token, { quoteId: fixture.quoteId, lineId, ...change, taxRateId: foreignTaxRateId }, lockToken),
          'tax_rate_not_found',
        ],
      ]
      for (const [label, send, code] of refusals) {
        const response = await send()
        expect(response.status(), `${label}: ${await response.text()}`).toBe(404)
        expect((await readJsonSafe<{ code: string }>(response))?.code, label).toBe(code)
      }

      const after = await readConfiguredLine(request, token, fixture.quoteId, lineId)
      expect(commercialFields(after), 'no refused request changed the line').toEqual(before)
      expectConfiguredInputs(after, fixture.productId, finalised)
      const quoteAfter = quoteLockToken(await readQuoteRecord(request, token, fixture.quoteId))
      expect(new Date(quoteAfter).getTime(), 'no refused request changed the quote').toBe(new Date(lockToken).getTime())
    } finally {
      await cleanup.run()
      for (const user of users) await deleteScopedUser(request, superadminToken, user)
      await deleteOrganizationIfExists(request, superadminToken, otherOrganizationId)
      await deleteForeignTenant(request, superadminToken, foreignTenant)
    }
  })
})
