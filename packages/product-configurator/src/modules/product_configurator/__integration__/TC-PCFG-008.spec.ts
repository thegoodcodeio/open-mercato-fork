import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { CATALOG_ITEMS_PATH, createUnitProductFixture, uniqueSuffix } from './helpers/fixtures'

async function deleteProductInOrganization(request: APIRequestContext, token: string, productId: string, organizationId: string) {
  await apiRequestWithSelectedOrg(request, 'DELETE', `/api/catalog/products?id=${productId}`, {
    token,
    selectedOrgId: organizationId,
  }).catch(() => undefined)
}

type CatalogItems = { items: Array<{ sku: string; title: string; unit: string | null }>; unknown: string[]; ambiguous: string[] }

test.describe('TC-PCFG-008: catalog items for the studio', () => {
  test('returns titles and units, lists unknown and ambiguous SKUs, stays in the selected organization, caps at 100', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const { organizationId: homeOrganizationId, tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-008-PART-${suffix}`
    const sharedSku = `QA-PCFG-008-SHARED-${suffix}`
    const foreignSku = `QA-PCFG-008-FOREIGN-${suffix}`
    const unknownSku = `QA-PCFG-008-NOPE-${suffix}`
    const homeProductIds: string[] = []
    let otherOrganizationId: string | null = null
    let foreignProductId: string | null = null

    try {
      homeProductIds.push(await createUnitProductFixture(request, token, { title: 'QA PCFG 008 part', sku: partSku, selectedOrgId: homeOrganizationId }))
      homeProductIds.push(await createUnitProductFixture(request, token, { title: 'QA PCFG 008 shared', sku: sharedSku, selectedOrgId: homeOrganizationId }))
      const parentId = await createUnitProductFixture(request, token, {
        title: 'QA PCFG 008 parent',
        sku: `QA-PCFG-008-PARENT-${suffix}`,
        selectedOrgId: homeOrganizationId,
      })
      homeProductIds.push(parentId)
      const variant = await apiRequestWithSelectedOrg(request, 'POST', '/api/catalog/variants', {
        token,
        selectedOrgId: homeOrganizationId,
        data: { productId: parentId, name: 'Shared SKU variant', sku: sharedSku, isDefault: false, isActive: true },
      })
      expect(variant.ok(), `Failed to create variant fixture: ${variant.status()}`).toBeTruthy()
      otherOrganizationId = await createOrganizationFixture(request, token, { name: `QA PCFG 008 ${suffix}`, tenantId })
      foreignProductId = await createUnitProductFixture(request, token, { title: 'QA PCFG 008 foreign', sku: foreignSku, selectedOrgId: otherOrganizationId })

      const skus = [partSku, sharedSku, foreignSku, unknownSku].join(',')
      const response = await apiRequestWithSelectedOrg(request, 'GET', `${CATALOG_ITEMS_PATH}?skus=${encodeURIComponent(skus)}`, {
        token,
        selectedOrgId: homeOrganizationId,
      })
      expect(response.status()).toBe(200)
      const body = (await readJsonSafe<CatalogItems>(response)) as CatalogItems
      expect(body.items).toEqual([{ sku: partSku, title: 'QA PCFG 008 part', unit: 'pc' }])
      expect(body.ambiguous).toEqual([sharedSku])
      expect(body.unknown.sort()).toEqual([foreignSku, unknownSku].sort())

      const tooMany = Array.from({ length: 101 }, (_, index) => `QA-PCFG-008-${index}`).join(',')
      const capped = await apiRequestWithSelectedOrg(request, 'GET', `${CATALOG_ITEMS_PATH}?skus=${encodeURIComponent(tooMany)}`, {
        token,
        selectedOrgId: homeOrganizationId,
      })
      expect(capped.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(capped))?.code).toBe('too_many_skus')
    } finally {
      for (const id of homeProductIds) await deleteProductInOrganization(request, token, id, homeOrganizationId)
      if (foreignProductId && otherOrganizationId) {
        await deleteProductInOrganization(request, token, foreignProductId, otherOrganizationId)
      }
      await deleteOrganizationIfExists(request, token, otherOrganizationId)
    }
  })
})
