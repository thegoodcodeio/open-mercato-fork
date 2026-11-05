import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  MODELS_PATH,
  VERSIONS_PATH,
  buildDefinition,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  publishModel,
  readModel,
  saveModel,
  uniqueSuffix,
} from './helpers/fixtures'

type PublishResult = { modelVersionId: string; version: number; hash: string }

test.describe('TC-PCFG-003: publishing freezes immutable versions', () => {
  test('publishes version 1 and 2, keeps versions read-only and the model selectable while the draft changes', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const partSku = `QA-PCFG-003-PART-${suffix}`
    const productIds: string[] = []
    let priceKindId: string | null = null
    let modelId: string | null = null

    try {
      const productId = await createUnitProductFixture(request, token, { title: `QA PCFG 003 ${suffix}`, sku: `QA-PCFG-003-${suffix}` })
      productIds.push(productId)
      productIds.push(await createUnitProductFixture(request, token, { title: `QA PCFG 003 part ${suffix}`, sku: partSku }))
      priceKindId = await createPriceKindFixture(request, token)
      const definition = buildDefinition({ priceKindId, partSku })
      modelId = await createModelFixture(request, token, { productId, priceKindId, draftDefinition: definition })

      const draft = await readModel(request, token, modelId)
      const first = await publishModel(request, token, modelId, draft.updatedAt)
      expect(first.status()).toBe(200)
      const v1 = (await readJsonSafe<PublishResult>(first)) as PublishResult
      expect(v1.version).toBe(1)
      expect(v1.hash).toMatch(/^[0-9a-f]{64}$/)

      const published = await readModel(request, token, modelId)
      expect(published.latestVersion).toMatchObject({ id: v1.modelVersionId, version: 1, hash: v1.hash })
      expect(published.hasUnpublishedChanges).toBe(false)

      const changedDefinition = { ...definition, fixedSpecification: [{ label: 'Voltage', value: '400 V' }] }
      const saved = await saveModel(request, token, { id: modelId, updatedAt: published.updatedAt, draftDefinition: changedDefinition })
      expect(saved.status()).toBe(200)

      const edited = await readModel(request, token, modelId)
      expect(edited.latestVersion?.id).toBe(v1.modelVersionId)
      expect(edited.hasUnpublishedChanges).toBe(true)
      const selectable = await apiRequest(request, 'GET', `${MODELS_PATH}?published=true&currencyCode=EUR&productId=${productId}`, { token })
      const selectableBody = await readJsonSafe<{ items?: Array<{ id: string }> }>(selectable)
      expect(selectableBody?.items?.map((item) => item.id)).toContain(modelId)

      const v1Detail = await apiRequest(request, 'GET', `${VERSIONS_PATH}?id=${v1.modelVersionId}`, { token })
      expect(v1Detail.status()).toBe(200)
      const v1Body = await readJsonSafe<{ version: number; hash: string; definition: Record<string, unknown>; validationReport: { ok: boolean } }>(v1Detail)
      expect(v1Body).toMatchObject({ version: 1, hash: v1.hash, validationReport: { ok: true } })
      expect(v1Body?.definition).toMatchObject({ fixedSpecification: [] })

      const second = await publishModel(request, token, modelId, edited.updatedAt)
      expect(second.status()).toBe(200)
      const v2 = (await readJsonSafe<PublishResult>(second)) as PublishResult
      expect(v2.version).toBe(2)
      expect(v2.hash).not.toBe(v1.hash)

      const versions = await apiRequest(request, 'GET', `${VERSIONS_PATH}?modelId=${modelId}`, { token })
      const versionsBody = await readJsonSafe<{ items?: Array<{ id: string; version: number; isLatest: boolean; definition?: unknown }> }>(versions)
      expect(versionsBody?.items?.map((item) => item.version)).toEqual([2, 1])
      expect(versionsBody?.items?.[0]).toMatchObject({ id: v2.modelVersionId, isLatest: true })
      expect(versionsBody?.items?.every((item) => item.definition === undefined)).toBe(true)

      for (const method of ['PUT', 'DELETE', 'POST']) {
        const write = await apiRequest(request, method, VERSIONS_PATH, { token, data: { id: v1.modelVersionId } })
        expect(write.ok(), `${method} ${VERSIONS_PATH} must not be allowed`).toBe(false)
      }
      const v1Again = await apiRequest(request, 'GET', `${VERSIONS_PATH}?id=${v1.modelVersionId}`, { token })
      expect((await readJsonSafe<{ hash: string }>(v1Again))?.hash).toBe(v1.hash)
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
