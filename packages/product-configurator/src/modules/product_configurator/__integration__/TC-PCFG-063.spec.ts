import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { ALL_ORGANIZATIONS, uniqueSuffix } from './helpers/fixtures'
import { openOrderConfigurations, signInWithToken } from './helpers/configuratorUi'
import { createForeignTenant, createUserWithFeatures, deleteForeignTenant, deleteScopedUser, type ForeignTenant, type ScopedUser } from './helpers/users'
import { Cleanup } from './helpers/sessions'
import { convertQuote, createConfiguredSession, finaliseOk, readSnapshots } from './helpers/finalise'

const ORDER_READER_FEATURES = ['product_configurator.snapshots.view', 'sales.orders.view']

test.describe('TC-PCFG-063: snapshot access from an order', () => {
  test.use({ actionTimeout: 15_000 })

  test('an order-only user reads the order configurations and one snapshot the order carries; quote reads stay closed; other organizations and tenants get 404', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const home = getTokenContext(adminToken)
    const cleanup = new Cleanup()
    const users: Array<ScopedUser | null> = []
    let otherOrganizationId: string | null = null
    let foreignTenant: ForeignTenant | null = null
    try {
      const fixture = await createConfiguredSession(request, adminToken, cleanup, '063', { title: 'QA PCFG 063 pump' })
      const result = await finaliseOk(request, adminToken, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const orderId = await convertQuote(request, adminToken, cleanup, fixture.quoteId)
      const elsewhere = await createConfiguredSession(request, adminToken, cleanup, '063B')
      const other = await finaliseOk(request, adminToken, { id: elsewhere.sessionId, expectedHash: elsewhere.evaluation.hash, revision: elsewhere.revision })

      const orderOnly = await createUserWithFeatures(request, superadminToken, '063-order', ORDER_READER_FEATURES, home)
      users.push(orderOnly)
      const quoteOnly = await createUserWithFeatures(request, superadminToken, '063-quote', ['product_configurator.snapshots.view', 'sales.quotes.view'], home)
      users.push(quoteOnly)
      const noSnapshots = await createUserWithFeatures(request, superadminToken, '063-none', ['sales.orders.view'], home)
      users.push(noSnapshots)

      const list = await readSnapshots(request, orderOnly.token, `orderId=${orderId}`)
      expect(list.status(), await list.text()).toBe(200)
      expect((await readJsonSafe<{ items: Array<{ id: string }> }>(list))?.items.map((item) => item.id)).toEqual([result.snapshotId])

      const one = await readSnapshots(request, orderOnly.token, `id=${result.snapshotId}&orderId=${orderId}`)
      expect(one.status()).toBe(200)
      expect(await readJsonSafe<{ id: string; lineState: string }>(one)).toMatchObject({ id: result.snapshotId, lineState: 'present' })

      const notCarried = await readSnapshots(request, orderOnly.token, `id=${other.snapshotId}&orderId=${orderId}`)
      expect(notCarried.status()).toBe(404)
      expect((await readJsonSafe<{ code: string }>(notCarried))?.code).toBe('snapshot_not_found')

      expect((await readSnapshots(request, orderOnly.token, `id=${result.snapshotId}`)).status()).toBe(403)
      expect((await readSnapshots(request, orderOnly.token, `quoteId=${elsewhere.quoteId}`)).status()).toBe(403)
      expect((await readSnapshots(request, quoteOnly.token, `orderId=${orderId}`)).status()).toBe(403)
      expect((await readSnapshots(request, quoteOnly.token, `id=${result.snapshotId}&orderId=${orderId}`)).status()).toBe(403)
      expect((await readSnapshots(request, noSnapshots.token, `orderId=${orderId}`)).status()).toBe(403)
      expect((await readSnapshots(request, adminToken, `orderId=${fixture.sessionId}`)).status()).toBe(404)

      otherOrganizationId = await createOrganizationFixture(request, superadminToken, { name: `QA PCFG 063 ${uniqueSuffix()}`, tenantId: home.tenantId })
      foreignTenant = await createForeignTenant(request, superadminToken, '063')
      const foreignReader = await createUserWithFeatures(request, superadminToken, '063-foreign', ORDER_READER_FEATURES, foreignTenant)
      users.push(foreignReader)
      const outsiders = [
        { label: 'another organization', token: superadminToken, options: { selectedOrgId: otherOrganizationId } },
        { label: 'another tenant', token: foreignReader.token, options: {} },
      ]
      for (const outsider of outsiders) {
        for (const query of [`orderId=${orderId}`, `id=${result.snapshotId}&orderId=${orderId}`]) {
          const response = await readSnapshots(request, outsider.token, query, outsider.options)
          expect(response.status(), `${outsider.label}: ${query}: ${await response.text()}`).toBe(404)
          expect((await readJsonSafe<{ items?: unknown }>(response))?.items, `${outsider.label}: ${query}`).toBeUndefined()
        }
      }
      for (const query of [`orderId=${orderId}`, `id=${result.snapshotId}&orderId=${orderId}`]) {
        const response = await readSnapshots(request, superadminToken, query, { selectedOrgId: ALL_ORGANIZATIONS })
        expect(response.status(), `all organizations: ${query}`).toBe(400)
        expect(await readJsonSafe<{ code: string; items?: unknown }>(response), `all organizations: ${query}`).toMatchObject({ code: 'organization_scope_required' })
      }

      await signInWithToken(page, orderOnly.token)
      const tab = await openOrderConfigurations(page, orderId)
      const row = tab.getByTestId(`order-configured-line-${result.snapshotId}`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).toContainText('QA PCFG 063 pump')
      await expect(tab.getByTestId(`order-configured-line-${other.snapshotId}`)).toHaveCount(0)
      await row.getByRole('link', { name: 'Configuration details' }).click()
      await page.waitForURL((url) => url.pathname.endsWith(`/snapshots/${result.snapshotId}`) && url.searchParams.get('orderId') === orderId, {
        timeout: 90_000,
        waitUntil: 'domcontentloaded',
      })
      const detail = page.getByTestId('snapshot-detail')
      await expect(detail).toBeVisible({ timeout: 90_000 })
      await expect(detail).toContainText('On order')
      await expect(page.getByTestId('snapshot-net-price')).toContainText('€100.00')
    } finally {
      await cleanup.run()
      for (const user of users) await deleteScopedUser(request, superadminToken, user)
      await deleteOrganizationIfExists(request, superadminToken, otherOrganizationId)
      await deleteForeignTenant(request, superadminToken, foreignTenant)
    }
  })
})
