import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export const MODELS_PATH = '/api/product_configurator/models'
export const VALIDATE_PATH = '/api/product_configurator/models/validate'
export const PUBLISH_PATH = '/api/product_configurator/models/publish'
export const VERSIONS_PATH = '/api/product_configurator/model-versions'
export const CATALOG_ITEMS_PATH = '/api/product_configurator/catalog-items'
export const MODEL_RESOURCE_KIND = 'product_configurator.model'
export const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'
export const ALL_ORGANIZATIONS = '__all__'

export type ModelDetail = {
  id: string
  title: string
  modelKey: string
  productId: string
  currencyCode: string
  updatedAt: string
  draftDefinition: Record<string, unknown>
  latestVersion: { id: string; version: number; hash: string } | null
  hasUnpublishedChanges: boolean
}

export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8)
}

/** A catalog product in the base unit `pc` (seeded by catalog `seedDefaults`), so BOM lines in `pc` match it. */
export async function createUnitProductFixture(
  request: APIRequestContext,
  token: string,
  input: { title: string; sku: string; selectedOrgId?: string },
): Promise<string> {
  const data = {
    title: input.title,
    sku: input.sku,
    defaultUnit: 'pc',
    description: 'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
  }
  const response = input.selectedOrgId
    ? await apiRequestWithSelectedOrg(request, 'POST', '/api/catalog/products', { token, selectedOrgId: input.selectedOrgId, data })
    : await apiRequest(request, 'POST', '/api/catalog/products', { token, data })
  expect(response.ok(), `Failed to create product fixture: ${response.status()}`).toBeTruthy()
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'Product create should return an id')
}

export async function createPriceKindFixture(request: APIRequestContext, token: string, currencyCode = 'EUR', title?: string): Promise<string> {
  const suffix = uniqueSuffix()
  const response = await apiRequest(request, 'POST', '/api/catalog/price-kinds', {
    token,
    data: { code: `qa_pcfg_${suffix}`, title: title ?? `QA PCFG ${suffix}`, currencyCode },
  })
  expect(response.ok(), `Failed to create price kind fixture: ${response.status()}`).toBeTruthy()
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'Price kind create should return an id')
}

export async function deletePriceKindIfExists(request: APIRequestContext, token: string | null, id: string | null): Promise<void> {
  if (!token || !id) return
  await apiRequest(request, 'DELETE', `/api/catalog/price-kinds?id=${encodeURIComponent(id)}`, { token }).catch(() => undefined)
}

export function buildDefinition(input: { priceKindId: string; currencyCode?: string; partSku?: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    commercial: { currencyCode: input.currencyCode ?? 'EUR', priceKindId: input.priceKindId, allowPromotions: false },
    fixedSpecification: [],
    features: [
      {
        key: 'size',
        label: 'Size',
        type: 'choice',
        options: [
          { value: 's', label: 'Small', order: 1 },
          { value: 'l', label: 'Large', order: 2 },
        ],
        default: 's',
        order: 1,
        inSummary: true,
      },
    ],
    rules: [],
    formulas: [],
    lookups: [],
    bom: input.partSku ? [{ id: 'body', sku: input.partSku, uom: 'pc', quantity: 1, when: [], order: 1 }] : [],
  }
}

export async function createModelFixture(
  request: APIRequestContext,
  token: string,
  input: {
    productId: string
    priceKindId: string
    modelKey?: string
    title?: string
    currencyCode?: string
    draftDefinition?: Record<string, unknown>
    selectedOrgId?: string
  },
): Promise<string> {
  const data = {
    productId: input.productId,
    priceKindId: input.priceKindId,
    modelKey: input.modelKey ?? `qa-pcfg-${uniqueSuffix()}`,
    title: input.title ?? 'QA configurator model',
    currencyCode: input.currencyCode ?? 'EUR',
    ...(input.draftDefinition ? { draftDefinition: input.draftDefinition } : {}),
  }
  const response = input.selectedOrgId
    ? await apiRequestWithSelectedOrg(request, 'POST', MODELS_PATH, { token, selectedOrgId: input.selectedOrgId, data })
    : await apiRequest(request, 'POST', MODELS_PATH, { token, data })
  expect(response.status(), `POST ${MODELS_PATH} should return 201`).toBe(201)
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'Model create should return an id')
}

export async function readModel(request: APIRequestContext, token: string, id: string): Promise<ModelDetail> {
  const response = await apiRequest(request, 'GET', `${MODELS_PATH}?id=${encodeURIComponent(id)}`, { token })
  expect(response.status(), `GET ${MODELS_PATH}?id should return 200`).toBe(200)
  const body = await readJsonSafe<{ items?: ModelDetail[] }>(response)
  const item = body?.items?.[0]
  expect(item, 'Model detail should be returned').toBeTruthy()
  return item as ModelDetail
}

export async function saveModel(
  request: APIRequestContext,
  token: string,
  input: { id: string; updatedAt: string; title?: string; draftDefinition?: Record<string, unknown> },
): Promise<APIResponse> {
  const { updatedAt, ...data } = input
  return apiRequest(request, 'PUT', MODELS_PATH, { token, data, headers: { [LOCK_HEADER]: updatedAt } })
}

export async function publishModel(request: APIRequestContext, token: string, id: string, updatedAt?: string): Promise<APIResponse> {
  return apiRequest(request, 'POST', PUBLISH_PATH, {
    token,
    data: { id },
    headers: updatedAt ? { [LOCK_HEADER]: updatedAt } : undefined,
  })
}

export async function deleteModelIfExists(request: APIRequestContext, token: string | null, id: string | null, selectedOrgId?: string): Promise<void> {
  if (!token || !id) return
  if (selectedOrgId) {
    await apiRequestWithSelectedOrg(request, 'DELETE', `${MODELS_PATH}?id=${encodeURIComponent(id)}`, { token, selectedOrgId }).catch(() => undefined)
    return
  }
  await apiRequest(request, 'DELETE', `${MODELS_PATH}?id=${encodeURIComponent(id)}`, { token }).catch(() => undefined)
}
