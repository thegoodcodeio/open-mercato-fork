import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './helpers/fixtures'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'
import { Cleanup } from './helpers/sessions'
import { createConfiguredSession, finaliseOk, readSnapshots } from './helpers/finalise'

type Snapshot = {
  id: string
  quoteId: string
  quoteLineId: string | null
  lineState: string
  lineName: string | null
  modelTitle: string | null
  modelVersion: { version: number | null }
  summary: string
  selectionRows: Array<{ label: string; value: unknown }>
  bom: Array<{ sku: string; quantity: string; unitPrice: string; total: string }>
  netPrice: string
  currencyCode: string
  hash: string
}

test.describe('TC-PCFG-043: snapshot routes', () => {
  test('read by quote and by id, gated by snapshots.view and sales.quotes.view, 404 across organizations', async ({ request }) => {
    test.setTimeout(180_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const tokenContext = getTokenContext(adminToken)
    const cleanup = new Cleanup()
    const users: Array<ScopedUser | null> = []
    let otherOrganizationId: string | null = null
    try {
      const fixture = await createConfiguredSession(request, adminToken, cleanup, '043', { title: 'QA PCFG 043 pump' })
      const result = await finaliseOk(request, adminToken, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })

      const byQuote = await readSnapshots(request, adminToken, `quoteId=${fixture.quoteId}`)
      expect(byQuote.status()).toBe(200)
      const items = (await readJsonSafe<{ items: Snapshot[] }>(byQuote))?.items ?? []
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: result.snapshotId,
        quoteId: fixture.quoteId,
        quoteLineId: result.quoteLineId,
        lineState: 'present',
        lineName: 'QA PCFG 043 pump',
        modelTitle: 'QA PCFG 043 pump',
        modelVersion: { version: 1 },
        summary: fixture.evaluation.summary,
        selectionRows: [{ label: 'Size', value: 'Large' }],
        netPrice: '100.0000',
        currencyCode: 'EUR',
        hash: fixture.evaluation.hash,
      })
      expect(items[0].bom).toEqual([expect.objectContaining({ quantity: '1', unitPrice: expect.any(String), total: '100.00' })])

      const byId = await readSnapshots(request, adminToken, `id=${result.snapshotId}`)
      expect(byId.status()).toBe(200)
      expect(await readJsonSafe<Snapshot>(byId)).toMatchObject({ id: result.snapshotId, lineState: 'present' })

      const createUser = async (label: string, features: string[]): Promise<ScopedUser> => {
        const user = await createUserWithFeatures(request, superadminToken, label, features, tokenContext)
        users.push(user)
        return user
      }
      const snapshotsOnly = await createUser('snap-only', ['product_configurator.snapshots.view'])
      const salesOnly = await createUser('sales-only', ['sales.quotes.view'])
      const both = await createUser('snap-sales', ['product_configurator.snapshots.view', 'sales.quotes.view'])
      for (const [label, user] of [['snapshots.view only', snapshotsOnly], ['sales.quotes.view only', salesOnly]] as const) {
        expect((await readSnapshots(request, user.token, `quoteId=${fixture.quoteId}`)).status(), label).toBe(403)
        expect((await readSnapshots(request, user.token, `id=${result.snapshotId}`)).status(), label).toBe(403)
      }
      expect((await readSnapshots(request, both.token, `quoteId=${fixture.quoteId}`)).status()).toBe(200)
      expect((await readSnapshots(request, both.token, `id=${result.snapshotId}`)).status()).toBe(200)

      otherOrganizationId = await createOrganizationFixture(request, superadminToken, { name: `QA PCFG 043 ${uniqueSuffix()}`, tenantId: tokenContext.tenantId })
      const other = { selectedOrgId: otherOrganizationId }
      expect((await readSnapshots(request, superadminToken, `id=${result.snapshotId}`, other)).status()).toBe(404)
      expect((await readSnapshots(request, superadminToken, `quoteId=${fixture.quoteId}`, other)).status()).toBe(404)

      const removed = await apiRequest(request, 'DELETE', '/api/sales/quote-lines', {
        token: adminToken,
        data: { id: result.quoteLineId, quoteId: fixture.quoteId },
      })
      expect(removed.ok(), await removed.text()).toBeTruthy()
      const afterRemoval = (await readJsonSafe<{ items: Snapshot[] }>(await readSnapshots(request, adminToken, `quoteId=${fixture.quoteId}`)))?.items ?? []
      expect(afterRemoval).toEqual([expect.objectContaining({ id: result.snapshotId, lineState: 'removed', lineName: null })])
      expect(await readJsonSafe<Snapshot>(await readSnapshots(request, adminToken, `id=${result.snapshotId}`))).toMatchObject({ lineState: 'removed' })
    } finally {
      await cleanup.run()
      for (const user of users) await deleteScopedUser(request, superadminToken, user)
      await deleteOrganizationIfExists(request, superadminToken, otherOrganizationId)
    }
  })
})
