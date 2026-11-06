import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createModelFixture,
  createPriceKindFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  publishModel,
  readModel,
  uniqueSuffix,
} from './fixtures'

export const SESSIONS_PATH = '/api/product_configurator/sessions'
export const EVALUATE_PATH = '/api/product_configurator/sessions/evaluate'
export const CANCEL_PATH = '/api/product_configurator/sessions/cancel'
export const SESSION_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.view']

export type EvaluatedBomLine = { bomId: string; sku: string; label: string; quantity: string; unitPrice: string; total: string }
export type Evaluation = {
  netPrice: string
  hash: string
  finalisable: boolean
  summary: string
  bom: EvaluatedBomLine[]
  errors: Array<{ code?: string; ruleId?: string; params: Record<string, unknown> }>
  priceContext: { channelId: string | null; customerId: string | null; customerGroupIds: string[] }
}
export type EvaluateResult = { id: string; status: string; revision: number; selections: Record<string, unknown>; evaluation: Evaluation }

/** Runs registered cleanups in reverse order; each step is best effort so one failure does not leak the rest. */
export class Cleanup {
  private readonly steps: Array<() => Promise<unknown>> = []

  add(step: () => Promise<unknown>): void {
    this.steps.push(step)
  }

  async run(): Promise<void> {
    for (const step of this.steps.reverse()) await step().catch(() => undefined)
  }
}

async function postForId(request: APIRequestContext, token: string, path: string, data: Record<string, unknown>, selectedOrgId?: string): Promise<string> {
  const response = selectedOrgId
    ? await apiRequestWithSelectedOrg(request, 'POST', path, { token, selectedOrgId, data })
    : await apiRequest(request, 'POST', path, { token, data })
  expect(response.ok(), `POST ${path} failed: ${response.status()} ${await response.text()}`).toBeTruthy()
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, `POST ${path} should return an id`)
}

async function deleteById(request: APIRequestContext, token: string, path: string, id: string, selectedOrgId?: string): Promise<void> {
  const url = `${path}?id=${encodeURIComponent(id)}`
  if (selectedOrgId) await apiRequestWithSelectedOrg(request, 'DELETE', url, { token, selectedOrgId })
  else await apiRequest(request, 'DELETE', url, { token })
}

/** A catalog product in a seeded base unit (`pc` or `m`). */
export async function createProduct(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  input: { title: string; sku: string; unit?: string },
): Promise<string> {
  const id = await postForId(request, token, '/api/catalog/products', {
    title: input.title,
    sku: input.sku,
    defaultUnit: input.unit ?? 'pc',
    description: 'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
  })
  cleanup.add(() => deleteById(request, token, '/api/catalog/products', id))
  return id
}

export async function createVariant(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  input: { productId: string; name: string; sku: string },
): Promise<string> {
  const id = await postForId(request, token, '/api/catalog/variants', { ...input, isDefault: false, isActive: true })
  cleanup.add(() => deleteById(request, token, '/api/catalog/variants', id))
  return id
}

export async function createPrice(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  input: {
    productId?: string
    variantId?: string
    priceKindId: string
    unitPriceNet: string
    currencyCode?: string
    minQuantity?: number
    customerGroupId?: string
    channelId?: string
  },
): Promise<string> {
  const id = await postForId(request, token, '/api/catalog/prices', { currencyCode: 'EUR', minQuantity: 1, ...input })
  cleanup.add(() => deleteById(request, token, '/api/catalog/prices', id))
  return id
}

export async function createPriceKind(request: APIRequestContext, token: string, cleanup: Cleanup, currencyCode = 'EUR'): Promise<string> {
  const id = await createPriceKindFixture(request, token, currencyCode)
  cleanup.add(() => deletePriceKindIfExists(request, token, id))
  return id
}

export async function createCompany(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  displayName: string,
  selectedOrgId?: string,
): Promise<string> {
  const id = await postForId(request, token, '/api/customers/companies', { displayName }, selectedOrgId)
  cleanup.add(() => deleteById(request, token, '/api/customers/companies', id, selectedOrgId))
  return id
}

export async function createSalesChannel(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  name: string,
  selectedOrgId?: string,
): Promise<string> {
  const id = await postForId(request, token, '/api/sales/channels', { name, code: `qa-pcfg-${uniqueSuffix()}` }, selectedOrgId)
  cleanup.add(() => deleteById(request, token, '/api/sales/channels', id, selectedOrgId))
  return id
}

export async function createQuote(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  input: { currencyCode?: string; customerEntityId?: string; channelId?: string; selectedOrgId?: string } = {},
): Promise<string> {
  const { selectedOrgId, ...data } = input
  const id = await postForId(request, token, '/api/sales/quotes', { currencyCode: 'EUR', ...data }, selectedOrgId)
  cleanup.add(() => deleteById(request, token, '/api/sales/quotes', id, selectedOrgId))
  return id
}

/** Creates a model with `definition` (its `commercial` filled in) on `productId` and publishes version 1. */
export async function createPublishedModel(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  input: { productId: string; priceKindId: string; definition: Record<string, unknown>; currencyCode?: string; title?: string },
): Promise<{ modelId: string; modelVersionId: string; hash: string }> {
  const currencyCode = input.currencyCode ?? 'EUR'
  const draftDefinition = { ...input.definition, commercial: { currencyCode, priceKindId: input.priceKindId, allowPromotions: false } }
  const modelId = await createModelFixture(request, token, {
    productId: input.productId,
    priceKindId: input.priceKindId,
    currencyCode,
    title: input.title,
    draftDefinition,
  })
  cleanup.add(() => deleteModelIfExists(request, token, modelId))
  const draft = await readModel(request, token, modelId)
  const published = await publishModel(request, token, modelId, draft.updatedAt)
  expect(published.status(), `publish should return 200: ${await published.text()}`).toBe(200)
  const body = (await readJsonSafe<{ modelVersionId: string; hash: string }>(published)) ?? { modelVersionId: '', hash: '' }
  return { modelId, modelVersionId: body.modelVersionId, hash: body.hash }
}

type SessionRequestOptions = { selectedOrgId?: string }

async function send(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  data: unknown,
  options: SessionRequestOptions,
): Promise<APIResponse> {
  return options.selectedOrgId
    ? apiRequestWithSelectedOrg(request, method, path, { token, selectedOrgId: options.selectedOrgId, data })
    : apiRequest(request, method, path, { token, data })
}

export function openSession(
  request: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
  options: SessionRequestOptions = {},
): Promise<APIResponse> {
  return send(request, token, 'POST', SESSIONS_PATH, data, options)
}

export function evaluateSession(
  request: APIRequestContext,
  token: string,
  data: { id: string; revision: number; selections: Record<string, unknown> },
  options: SessionRequestOptions = {},
): Promise<APIResponse> {
  return send(request, token, 'POST', EVALUATE_PATH, data, options)
}

export function cancelSession(request: APIRequestContext, token: string, id: string, options: SessionRequestOptions = {}): Promise<APIResponse> {
  return send(request, token, 'POST', CANCEL_PATH, { id }, options)
}

export function readSession(request: APIRequestContext, token: string, query: string, options: SessionRequestOptions = {}): Promise<APIResponse> {
  return send(request, token, 'GET', `${SESSIONS_PATH}?${query}`, undefined, options)
}

/** Opens a session and registers its cancellation, so open sessions do not pile up in the dev database. */
export async function openSessionId(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await openSession(request, token, data)
  expect(response.status(), `POST ${SESSIONS_PATH} should return 201: ${await response.text()}`).toBe(201)
  const sessionId = expectId((await readJsonSafe<{ sessionId?: string }>(response))?.sessionId, 'open should return a session id')
  cleanup.add(() => cancelSession(request, token, sessionId))
  return sessionId
}

export async function evaluateOk(
  request: APIRequestContext,
  token: string,
  data: { id: string; revision: number; selections: Record<string, unknown> },
): Promise<EvaluateResult> {
  const response = await evaluateSession(request, token, data)
  expect(response.status(), `POST ${EVALUATE_PATH} should return 200: ${await response.text()}`).toBe(200)
  return (await readJsonSafe<EvaluateResult>(response)) as EvaluateResult
}

/** One-part model: a fixed SKU in `pc`, a choice feature in the summary. */
export function singlePartDefinition(partSku: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
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
    bom: [{ id: 'part', sku: partSku, uom: 'pc', quantity: 1, when: [], order: 1 }],
  }
}

/** A published one-part model with a 100.00 base price for the part, on a fresh bound product. */
export async function createSinglePartModel(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  label: string,
  options: { currencyCode?: string } = {},
): Promise<{ modelId: string; modelVersionId: string; partProductId: string; priceKindId: string }> {
  const suffix = uniqueSuffix()
  const currencyCode = options.currencyCode ?? 'EUR'
  const productId = await createProduct(request, token, cleanup, { title: `QA PCFG ${label} ${suffix}`, sku: `QA-PCFG-${label}-${suffix}` })
  const partSku = `QA-PCFG-${label}-PART-${suffix}`
  const partProductId = await createProduct(request, token, cleanup, { title: `QA PCFG ${label} part ${suffix}`, sku: partSku })
  const priceKindId = await createPriceKind(request, token, cleanup, currencyCode)
  await createPrice(request, token, cleanup, { productId: partProductId, priceKindId, unitPriceNet: '100.00', currencyCode })
  const model = await createPublishedModel(request, token, cleanup, {
    productId,
    priceKindId,
    currencyCode,
    definition: singlePartDefinition(partSku),
  })
  return { ...model, partProductId, priceKindId }
}
