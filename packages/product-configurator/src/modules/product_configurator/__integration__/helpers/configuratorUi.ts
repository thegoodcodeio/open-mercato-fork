import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { finaliseOk } from './finalise'
import { publishModel, readModel, saveModel, uniqueSuffix } from './fixtures'
import { Cleanup, createPrice, createPriceKind, createProduct, createPublishedModel, createQuote, evaluateOk, openSessionId } from './sessions'

export const QUOTE_TAB_ID = 'product_configurator.injection.quote-configurations-tab'

export function configureUrl(sessionId: string): string {
  return `/backend/product_configurator/configure/${sessionId}`
}

export function quoteUrl(quoteId: string): string {
  return `/backend/sales/quotes/${quoteId}`
}

export function snapshotUrl(snapshotId: string, quoteId: string): string {
  return `/backend/product_configurator/snapshots/${snapshotId}?quoteId=${quoteId}`
}

/**
 * A frame model for the configurator UI, prices worked out by hand:
 * - frame part 100.00, cover part 25.00
 * - Small, no cover: 100.00; Small with cover: 125.00; Large forces the cover: 125.00
 * - "Cover colour" is shown only while the cover is on
 * - Small and longer than 8 m is a blocking error
 */
export function frameDefinition(skus: { frame: string; cover: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    fixedSpecification: [{ label: 'Material', value: 'Galvanised steel' }],
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
      { key: 'cover', label: 'Weather cover', type: 'boolean', default: false, order: 2, inSummary: true },
      {
        key: 'cover_color',
        label: 'Cover colour',
        type: 'choice',
        options: [
          { value: 'grey', label: 'Grey', order: 1 },
          { value: 'green', label: 'Green', order: 2 },
        ],
        default: 'grey',
        order: 3,
        inSummary: true,
        visibleWhen: [{ kind: 'compare', featureKey: 'cover', op: 'eq', value: true }],
      },
      { key: 'length', label: 'Length', type: 'number', min: 1, max: 10, step: 0.5, unit: 'm', default: 2, order: 4, inSummary: true },
    ],
    rules: [
      {
        id: 'large-cover',
        label: 'Large frames come with a cover',
        effect: 'force',
        when: [{ kind: 'compare', featureKey: 'size', op: 'eq', value: 'l' }],
        action: { kind: 'set', featureKey: 'cover', value: true },
        messageTemplate: 'Large frames come with a cover.',
        featureKeys: ['cover'],
        order: 1,
      },
      {
        id: 'small-length',
        label: 'Small frames up to 8 m',
        effect: 'error',
        when: [
          { kind: 'compare', featureKey: 'size', op: 'eq', value: 's' },
          { kind: 'compare', featureKey: 'length', op: 'gt', value: 8 },
        ],
        messageTemplate: 'Small frames cannot be longer than 8 m.',
        featureKeys: ['length', 'size'],
        order: 2,
      },
    ],
    formulas: [],
    lookups: [],
    bom: [
      { id: 'frame', sku: skus.frame, uom: 'pc', quantity: 1, when: [], order: 1 },
      { id: 'cover', sku: skus.cover, uom: 'pc', quantity: 1, when: [{ kind: 'compare', featureKey: 'cover', op: 'eq', value: true }], order: 2 },
    ],
  }
}

export type FrameFixture = {
  modelId: string
  modelTitle: string
  quoteId: string
  frameProductId: string
  coverProductId: string
  priceKindId: string
  framePriceId: string
}

export async function createFrameFixture(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  label: string,
  options: { definition?: (skus: { frame: string; cover: string }) => Record<string, unknown>; quoteId?: string } = {},
): Promise<FrameFixture> {
  const suffix = uniqueSuffix()
  const productId = await createProduct(request, token, cleanup, { title: `QA PCFG ${label} frame ${suffix}`, sku: `QA-PCFG-${label}-${suffix}` })
  const skus = { frame: `QA-PCFG-${label}-FRAME-${suffix}`, cover: `QA-PCFG-${label}-COVER-${suffix}` }
  const frameProductId = await createProduct(request, token, cleanup, { title: `QA PCFG ${label} frame part ${suffix}`, sku: skus.frame })
  const coverProductId = await createProduct(request, token, cleanup, { title: `QA PCFG ${label} cover part ${suffix}`, sku: skus.cover })
  const priceKindId = await createPriceKind(request, token, cleanup)
  const framePriceId = await createPrice(request, token, cleanup, { productId: frameProductId, priceKindId, unitPriceNet: '100.00' })
  await createPrice(request, token, cleanup, { productId: coverProductId, priceKindId, unitPriceNet: '25.00' })
  const modelTitle = `QA PCFG ${label} model ${suffix}`
  const model = await createPublishedModel(request, token, cleanup, {
    productId,
    priceKindId,
    title: modelTitle,
    definition: (options.definition ?? frameDefinition)(skus),
  })
  const quoteId = options.quoteId ?? (await createQuote(request, token, cleanup))
  return { modelId: model.modelId, modelTitle, quoteId, frameProductId, coverProductId, priceKindId, framePriceId }
}

/** Opens a session through the API and the configure page for it, once the first evaluation shows a price. */
export async function openConfigurePage(
  page: Page,
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  fixture: FrameFixture,
): Promise<string> {
  const sessionId = await openSessionId(request, token, cleanup, { quoteId: fixture.quoteId, modelId: fixture.modelId })
  await page.goto(configureUrl(sessionId), { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('configurator-net-price')).not.toHaveText('-', { timeout: 90_000 })
  return sessionId
}

export async function openQuoteConfigurations(page: Page, quoteId: string): Promise<Locator> {
  await page.goto(quoteUrl(quoteId), { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-tab-id="${QUOTE_TAB_ID}"]`).click({ timeout: 90_000 })
  const tab = page.getByTestId('quote-configurations-tab')
  await expect(tab).toBeVisible({ timeout: 30_000 })
  return tab
}

export function netPrice(page: Page): Locator {
  return page.getByTestId('configurator-net-price')
}

export function addToQuote(page: Page): Locator {
  return page.getByTestId('configurator-add-to-quote')
}

export const HYDRATION_ERROR = /hydrat|did not match|server rendered|Minified React error #4(18|19|23|25)/i

export function collectPageErrors(page: Page): { console: string[]; uncaught: string[] } {
  const errors: { console: string[]; uncaught: string[] } = { console: [], uncaught: [] }
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text())
  })
  page.on('pageerror', (error) => errors.uncaught.push(error.message))
  return errors
}

export function expectNoHydrationErrors(errors: { console: string[]; uncaught: string[] }): void {
  const all = [...errors.console, ...errors.uncaught]
  expect(all.filter((line) => HYDRATION_ERROR.test(line)), 'no hydration errors').toEqual([])
  expect(errors.uncaught, 'no uncaught runtime errors').toEqual([])
}

/** "Configure product" on the quote tab; picks the model by title when other published models also fit. */
export async function startConfiguration(page: Page, tab: Locator, modelTitle: string): Promise<string> {
  await tab.getByTestId('quote-configure-product').click()
  const picker = page.getByTestId('quote-configure-model-picker')
  const opened = page.waitForURL(/\/backend\/product_configurator\/configure\/[0-9a-f-]{36}/, { timeout: 90_000, waitUntil: 'domcontentloaded' })
  // Keeps a timeout from becoming an unhandled rejection while an earlier step fails; `await opened` still throws it.
  opened.catch(() => undefined)
  await expect(picker.or(page.getByTestId('configurator-session'))).toBeVisible({ timeout: 90_000 })
  if (await picker.isVisible()) {
    await picker.getByRole('radio', { name: new RegExp(modelTitle) }).click()
    await picker.getByRole('button', { name: 'Start' }).click()
  }
  await opened
  const match = /configure\/([0-9a-f-]{36})/.exec(page.url())
  if (!match) throw new Error(`[internal] no configuration session id in ${page.url()}`)
  return match[1]
}

export const ORDER_TAB_ID = 'product_configurator.injection.order-configurations-tab'

export function orderUrl(orderId: string): string {
  return `/backend/sales/orders/${orderId}`
}

/** Signs the browser in with an API token (e.g. a `createUserWithFeatures` user), in the token's organization. */
export async function signInWithToken(page: Page, token: string): Promise<void> {
  const baseUrl = process.env.BASE_URL
  expect(baseUrl, 'the integration base URL is set').toBeTruthy()
  const url = baseUrl as string
  const { tenantId, organizationId } = getTokenContext(token)
  await page.context().addCookies([
    { name: 'auth_token', value: token, url, sameSite: 'Lax' },
    { name: 'om_selected_tenant', value: tenantId, url, sameSite: 'Lax' },
    { name: 'om_selected_org', value: organizationId, url, sameSite: 'Lax' },
    { name: 'om_demo_notice_ack', value: 'ack', url },
    { name: 'om_cookie_notice_ack', value: 'ack', url },
    { name: 'om_feedback_suppress', value: '1', url },
  ])
}

export async function openOrderConfigurations(page: Page, orderId: string): Promise<Locator> {
  await page.goto(orderUrl(orderId), { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-tab-id="${ORDER_TAB_ID}"]`).click({ timeout: 90_000 })
  const tab = page.getByTestId('order-configurations-tab')
  await expect(tab).toBeVisible({ timeout: 30_000 })
  return tab
}

export type FinalisedFrame = { sessionId: string; snapshotId: string; quoteLineId: string; netPrice: string }

/** Configures the frame model on its quote through the API and adds it as a line. */
export async function finaliseFrame(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  fixture: FrameFixture,
  selections: Record<string, unknown> = {},
): Promise<FinalisedFrame> {
  const sessionId = await openSessionId(request, token, cleanup, { quoteId: fixture.quoteId, modelId: fixture.modelId })
  const evaluated = await evaluateOk(request, token, { id: sessionId, revision: 0, selections })
  const added = await finaliseOk(request, token, { id: sessionId, expectedHash: evaluated.evaluation.hash, revision: evaluated.revision })
  return { sessionId, snapshotId: added.snapshotId, quoteLineId: added.quoteLineId, netPrice: evaluated.evaluation.netPrice }
}

/** Saves the model draft changed by `change` and publishes it as the next version. */
export async function publishChangedDraft(
  request: APIRequestContext,
  token: string,
  modelId: string,
  change: (definition: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const current = await readModel(request, token, modelId)
  const saved = await saveModel(request, token, { id: modelId, updatedAt: current.updatedAt, draftDefinition: change(current.draftDefinition) })
  expect(saved.status(), `PUT model should return 200: ${await saved.text()}`).toBe(200)
  const draft = await readModel(request, token, modelId)
  const published = await publishModel(request, token, modelId, draft.updatedAt)
  expect(published.status(), `publish should return 200: ${await published.text()}`).toBe(200)
}
