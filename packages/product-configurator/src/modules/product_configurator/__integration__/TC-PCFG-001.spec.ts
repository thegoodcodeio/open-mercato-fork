import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
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
})
