import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { uniqueSuffix } from './fixtures'
import { Cleanup, createPrice, createPriceKind, createProduct, createPublishedModel, createQuote, openSessionId } from './sessions'

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
