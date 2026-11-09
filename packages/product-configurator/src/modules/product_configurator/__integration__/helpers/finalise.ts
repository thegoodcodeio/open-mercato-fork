import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './fixtures'
import {
  Cleanup,
  createPrice,
  createPriceKind,
  createProduct,
  createPublishedModel,
  createQuote,
  evaluateOk,
  openSessionId,
  singlePartDefinition,
  type Evaluation,
} from './sessions'

export const FINALISE_PATH = '/api/product_configurator/sessions/finalise'
export const SNAPSHOTS_PATH = '/api/product_configurator/snapshots'
export const FINALISE_FEATURES = ['product_configurator.sessions.manage', 'sales.quotes.manage', 'sales.quotes.view']

export type SalesLine = Record<string, unknown> & { id: string }
export type FinaliseBody = { snapshotId: string; quoteLineId: string; hash: string; replay: boolean }

type RequestOptions = { selectedOrgId?: string }

export function finalise(
  request: APIRequestContext,
  token: string,
  data: { id: string; expectedHash: string; revision: number; migrationAcknowledged?: boolean },
  options: RequestOptions = {},
): Promise<APIResponse> {
  return options.selectedOrgId
    ? apiRequestWithSelectedOrg(request, 'POST', FINALISE_PATH, { token, selectedOrgId: options.selectedOrgId, data })
    : apiRequest(request, 'POST', FINALISE_PATH, { token, data })
}

export async function finaliseOk(
  request: APIRequestContext,
  token: string,
  data: { id: string; expectedHash: string; revision: number },
): Promise<FinaliseBody> {
  const response = await finalise(request, token, data)
  expect(response.status(), `POST ${FINALISE_PATH} should return 200: ${await response.text()}`).toBe(200)
  return (await readJsonSafe<FinaliseBody>(response)) as FinaliseBody
}

export function readSnapshots(request: APIRequestContext, token: string, query: string, options: RequestOptions = {}): Promise<APIResponse> {
  const path = `${SNAPSHOTS_PATH}?${query}`
  return options.selectedOrgId
    ? apiRequestWithSelectedOrg(request, 'GET', path, { token, selectedOrgId: options.selectedOrgId })
    : apiRequest(request, 'GET', path, { token })
}

/** Sales returns line fields in snake_case on the list route; this reads either spelling. */
export function lineField(line: SalesLine, camel: string): unknown {
  const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  return line[snake] ?? line[camel]
}

export function lineConfiguration(line: SalesLine): Record<string, unknown> | null {
  const value = lineField(line, 'configuration')
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export async function documentLines(request: APIRequestContext, token: string, kind: 'quote' | 'order', documentId: string): Promise<SalesLine[]> {
  const param = kind === 'quote' ? 'quoteId' : 'orderId'
  const response = await apiRequest(request, 'GET', `/api/sales/${kind}-lines?${param}=${encodeURIComponent(documentId)}&pageSize=100`, { token })
  expect(response.ok(), `GET ${kind} lines failed: ${response.status()}`).toBeTruthy()
  return (await readJsonSafe<{ items?: SalesLine[] }>(response))?.items ?? []
}

export async function readQuoteRecord(request: APIRequestContext, token: string, quoteId: string): Promise<Record<string, unknown> | null> {
  const response = await apiRequest(request, 'GET', `/api/sales/quotes?id=${encodeURIComponent(quoteId)}`, { token })
  if (!response.ok()) return null
  const items = (await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(response))?.items ?? []
  return items.find((item) => item.id === quoteId) ?? null
}

/** Converts the quote and registers deletion of the order the conversion creates. */
export async function convertQuote(request: APIRequestContext, token: string, cleanup: Cleanup, quoteId: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/sales/quotes/convert', { token, data: { quoteId } })
  expect(response.status(), `POST /api/sales/quotes/convert should be 200: ${await response.text()}`).toBe(200)
  const orderId = expectId((await readJsonSafe<{ orderId?: string }>(response))?.orderId, 'convert should return the order id')
  cleanup.add(() => apiRequest(request, 'DELETE', `/api/sales/orders?id=${encodeURIComponent(orderId)}`, { token }))
  return orderId
}

export async function createTaxRate(request: APIRequestContext, token: string, cleanup: Cleanup, rate: number): Promise<string> {
  const suffix = uniqueSuffix()
  const response = await apiRequest(request, 'POST', '/api/sales/tax-rates', {
    token,
    data: { name: `QA PCFG VAT ${suffix}`, code: `qa-pcfg-vat-${suffix}`.toLowerCase(), rate },
  })
  expect(response.status(), `POST /api/sales/tax-rates failed: ${await response.text()}`).toBe(201)
  const id = expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'tax rate id')
  cleanup.add(() => apiRequest(request, 'DELETE', `/api/sales/tax-rates?id=${encodeURIComponent(id)}`, { token }))
  return id
}

export async function setProductTaxRate(request: APIRequestContext, token: string, productId: string, taxRateId: string | null): Promise<void> {
  const response = await apiRequest(request, 'PUT', '/api/catalog/products', { token, data: { id: productId, taxRateId } })
  expect(response.ok(), `PUT /api/catalog/products failed: ${response.status()} ${await response.text()}`).toBeTruthy()
}

async function createProductWithoutSku(request: APIRequestContext, token: string, cleanup: Cleanup, title: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/catalog/products', {
    token,
    data: {
      title,
      defaultUnit: 'pc',
      description: 'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
    },
  })
  expect(response.ok(), `POST /api/catalog/products failed: ${response.status()} ${await response.text()}`).toBeTruthy()
  const id = expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'product id')
  cleanup.add(() => apiRequest(request, 'DELETE', `/api/catalog/products?id=${encodeURIComponent(id)}`, { token }))
  return id
}

export type ConfiguredFixture = {
  modelId: string
  productId: string
  partProductId: string
  priceKindId: string
  priceId: string
  quoteId: string
  sessionId: string
  revision: number
  evaluation: Evaluation
}

/**
 * A published one-part model (part priced 100.00) on a fresh bound product, a quote, an open session
 * evaluated once (revision 1). The bound product can carry a tax rate or have no SKU.
 */
export async function createConfiguredSession(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  label: string,
  options: { taxRateId?: string; withoutSku?: boolean; quoteId?: string; title?: string } = {},
): Promise<ConfiguredFixture> {
  const suffix = uniqueSuffix()
  const title = `QA PCFG ${label} ${suffix}`
  const productId = options.withoutSku
    ? await createProductWithoutSku(request, token, cleanup, title)
    : await createProduct(request, token, cleanup, { title, sku: `QA-PCFG-${label}-${suffix}` })
  if (options.taxRateId) await setProductTaxRate(request, token, productId, options.taxRateId)
  const partSku = `QA-PCFG-${label}-PART-${suffix}`
  const partProductId = await createProduct(request, token, cleanup, { title: `${title} part`, sku: partSku })
  const priceKindId = await createPriceKind(request, token, cleanup)
  const priceId = await createPrice(request, token, cleanup, { productId: partProductId, priceKindId, unitPriceNet: '100.00' })
  const model = await createPublishedModel(request, token, cleanup, {
    productId,
    priceKindId,
    definition: singlePartDefinition(partSku),
    title: options.title ?? `QA PCFG ${label} model ${suffix}`,
  })
  const quoteId = options.quoteId ?? (await createQuote(request, token, cleanup))
  const sessionId = await openSessionId(request, token, cleanup, { quoteId, modelId: model.modelId })
  const evaluated = await evaluateOk(request, token, { id: sessionId, revision: 0, selections: { size: 'l' } })
  return {
    modelId: model.modelId,
    productId,
    partProductId,
    priceKindId,
    priceId,
    quoteId,
    sessionId,
    revision: evaluated.revision,
    evaluation: evaluated.evaluation,
  }
}

export function configuredLines(lines: SalesLine[]): SalesLine[] {
  return lines.filter((line) => lineConfiguration(line)?.productConfigurator !== undefined)
}
