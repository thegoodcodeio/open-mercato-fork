import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  LOCK_HEADER,
  MODELS_PATH,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  readModel,
  saveModel,
  uniqueSuffix,
} from './helpers/fixtures'

test.describe('TC-PCFG-001: configuration model create, update, delete', () => {
  test('creates a skeleton draft, saves with the lock header, rejects a stale save and a duplicate key, deletes', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let productId: string | null = null
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title: `QA PCFG 001 ${suffix}`, sku: `QA-PCFG-001-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      const modelKey = `qa-pcfg-001-${suffix}`
      modelId = await createModelFixture(request, token, { productId, priceKindId, modelKey, title: 'Pump' })

      const created = await readModel(request, token, modelId)
      expect(created).toMatchObject({ title: 'Pump', modelKey, productId, currencyCode: 'EUR', latestVersion: null })
      expect(created.draftDefinition).toMatchObject({
        schemaVersion: 1,
        commercial: { currencyCode: 'EUR', priceKindId },
        features: [],
        bom: [],
      })

      const duplicate = await apiRequest(request, 'POST', MODELS_PATH, {
        token,
        data: { productId, priceKindId, modelKey, title: 'Other', currencyCode: 'EUR' },
      })
      expect(duplicate.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(duplicate))?.code).toBe('duplicate_model_key')

      const saved = await saveModel(request, token, { id: modelId, updatedAt: created.updatedAt, title: 'Pump XL' })
      expect(saved.status()).toBe(200)
      const savedBody = await readJsonSafe<{ id?: string; updatedAt?: string }>(saved)
      expect(savedBody?.id).toBe(modelId)

      const stale = await saveModel(request, token, { id: modelId, updatedAt: created.updatedAt, title: 'Lost update' })
      expect(stale.status()).toBe(409)

      const afterSave = await readModel(request, token, modelId)
      expect(afterSave.title).toBe('Pump XL')

      const changedCurrency = await saveModel(request, token, {
        id: modelId,
        updatedAt: afterSave.updatedAt,
        draftDefinition: { ...afterSave.draftDefinition, commercial: { currencyCode: 'USD', priceKindId } },
      })
      expect(changedCurrency.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(changedCurrency))?.code).toBe('invalid_definition')

      const staleDelete = await apiRequest(request, 'DELETE', `${MODELS_PATH}?id=${modelId}`, {
        token,
        headers: { [LOCK_HEADER]: created.updatedAt },
      })
      expect(staleDelete.status()).toBe(409)

      const deleted = await apiRequest(request, 'DELETE', `${MODELS_PATH}?id=${modelId}`, {
        token,
        headers: { [LOCK_HEADER]: afterSave.updatedAt },
      })
      expect(deleted.status()).toBe(200)

      const gone = await apiRequest(request, 'GET', `${MODELS_PATH}?id=${modelId}`, { token })
      expect(gone.status()).toBe(404)
      modelId = null
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
  test('list search matches title or key as plain text in the database query: paged, scoped, % and _ literal', async ({ request }) => {
    const token = await getAuthToken(request, 'superadmin')
    const { organizationId: homeOrganizationId, tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const home = { token, selectedOrgId: homeOrganizationId }
    let otherOrganizationId: string | null = null
    let otherOrganizationModelId: string | null = null
    const modelIds: string[] = []

    const create = async (modelKey: string, title: string, selectedOrgId: string): Promise<string> =>
      createModelFixture(request, token, { productId: randomUUID(), priceKindId: randomUUID(), modelKey, title, selectedOrgId })
    const list = async (search: string, page = 1, pageSize = 100) => {
      const query = `page=${page}&pageSize=${pageSize}&sortField=modelKey&sortDir=asc&search=${encodeURIComponent(search)}`
      const response = await apiRequestWithSelectedOrg(request, 'GET', `${MODELS_PATH}?${query}`, home)
      expect(response.status()).toBe(200)
      const body = await readJsonSafe<{ items: Array<{ modelKey: string }>; total: number; totalPages: number }>(response)
      return { keys: (body?.items ?? []).map((item) => item.modelKey), total: body?.total, totalPages: body?.totalPages }
    }

    try {
      otherOrganizationId = await createOrganizationFixture(request, token, { name: `QA PCFG 001 ${suffix}`, tenantId })
      const fillerKeys = ['01', '02', '03', '07'].map((index) => `qa-pcfg-001-filler-${index}-${suffix}`)
      for (const [position, modelKey] of fillerKeys.entries()) {
        modelIds.push(await create(modelKey, `QA PCFG 001 Filler ${['01', '02', '03', '07'][position]} ${suffix}`, homeOrganizationId))
      }
      const percentKey = `qa_pcfg_001_under_${suffix}`
      modelIds.push(await create(percentKey, `QA PCFG 001 50% off ${suffix}`, homeOrganizationId))
      const deletedId = await create(`qa-pcfg-001-filler-09-${suffix}`, `QA PCFG 001 Filler 09 ${suffix}`, homeOrganizationId)
      modelIds.push(deletedId)
      const deleted = await readModel(request, token, deletedId)
      const deleteResponse = await apiRequest(request, 'DELETE', `${MODELS_PATH}?id=${deletedId}`, {
        token,
        headers: { [LOCK_HEADER]: deleted.updatedAt, Cookie: `om_selected_org=${homeOrganizationId}` },
      })
      expect(deleteResponse.status()).toBe(200)
      otherOrganizationModelId = await create(`qa-pcfg-001-filler-08-${suffix}`, `QA PCFG 001 Filler 08 ${suffix}`, otherOrganizationId)

      const pages = [await list(`-${suffix}`, 1, 3), await list(`-${suffix}`, 2, 3)]
      expect(pages.map((page) => [page.total, page.totalPages, page.keys.length])).toEqual([
        [4, 2, 3],
        [4, 2, 1],
      ])
      expect(pages.flatMap((page) => page.keys), 'no deleted match and no match of another organization').toEqual(fillerKeys)

      expect((await list(fillerKeys[0])).keys).toEqual([fillerKeys[0]])
      expect((await list(`Filler 07 ${suffix}`)).keys).toEqual([fillerKeys[3]])
      expect((await list(`Filler 08 ${suffix}`)).total, 'a match in another organization is not listed').toBe(0)
      expect((await list(`Filler 09 ${suffix}`)).total, 'a deleted match is not listed').toBe(0)
      expect((await list(`50% off ${suffix}`)).keys).toEqual([percentKey])
      expect((await list(`001_under_${suffix}`)).keys).toEqual([percentKey])
      expect((await list(`001%under_${suffix}`)).keys).toEqual([])
      expect((await list(`Filler 0_ ${suffix}`)).keys).toEqual([])

      const ownerList = await apiRequestWithSelectedOrg(request, 'GET', `${MODELS_PATH}?search=${encodeURIComponent(`Filler 08 ${suffix}`)}`, {
        token,
        selectedOrgId: otherOrganizationId,
      })
      const ownerBody = await readJsonSafe<{ items: Array<{ id: string }> }>(ownerList)
      expect(ownerBody?.items.map((item) => item.id), 'the owning organization finds its model').toEqual([otherOrganizationModelId])
    } finally {
      for (const id of modelIds) await deleteModelIfExists(request, token, id, homeOrganizationId)
      await deleteModelIfExists(request, token, otherOrganizationModelId, otherOrganizationId ?? undefined)
      await deleteOrganizationIfExists(request, token, otherOrganizationId)
    }
  })
})
