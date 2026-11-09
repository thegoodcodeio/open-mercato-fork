import { expect, test, type APIRequestContext } from '@playwright/test'
import { acknowledgeGlobalNotices } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  buildDefinition,
  createModelFixture,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  MODELS_PATH,
  publishModel,
  readModel,
  uniqueSuffix,
} from './helpers/fixtures'
import { MODELS_LIST_URL, versionUrl } from './helpers/studioUi'
import { createUserWithFeatures, deleteScopedUser, type ScopedUser } from './helpers/users'

test.describe('TC-PCFG-065: a view-only user reads published versions, never the studio', () => {
  test.use({ actionTimeout: 15_000 })

  test('rows open the latest published version, unpublished rows open nothing, the version page links back to the list', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(180_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const token = await getAuthToken(request, 'admin')
    const scope = getTokenContext(token)
    const suffix = uniqueSuffix()
    let viewer: ScopedUser | null = null
    let productId: string | null = null
    let priceKindId: string | null = null
    let publishedId: string | null = null
    let draftId: string | null = null

    try {
      productId = await createUnitProductFixture(request, token, { title: `QA PCFG 065 ${suffix}`, sku: `QA-PCFG-065-${suffix}` })
      priceKindId = await createPriceKindFixture(request, token)
      const definition = buildDefinition({ priceKindId })
      const publishedTitle = `QA PCFG 065 published ${suffix}`
      const draftTitle = `QA PCFG 065 draft ${suffix}`
      publishedId = await createModelFixture(request, token, { productId, priceKindId, title: publishedTitle, draftDefinition: definition })
      draftId = await createModelFixture(request, token, { productId, priceKindId, title: draftTitle, draftDefinition: definition })
      const draft = await readModel(request, token, publishedId)
      const published = await publishModel(request, token, publishedId, draft.updatedAt)
      expect(published.status()).toBe(200)
      const { modelVersionId } = (await readJsonSafe<{ modelVersionId: string }>(published)) ?? { modelVersionId: '' }
      expect(modelVersionId).toBeTruthy()

      viewer = await createUserWithFeatures(request, superadminToken, 'view-only', ['product_configurator.models.view'], scope)
      const priceKindsPath = `/api/product_configurator/price-kinds?ids=${priceKindId}&pageSize=1`
      const managerKinds = await apiRequest(request, 'GET', priceKindsPath, { token })
      expect(managerKinds.status()).toBe(200)
      const managerKindsBody = await readJsonSafe<{ items: Array<{ id: string }> }>(managerKinds)
      expect(managerKindsBody?.items.map((item) => item.id)).toEqual([priceKindId])
      const viewerKinds = await apiRequest(request, 'GET', priceKindsPath, { token: viewer.token })
      expect(viewerKinds.status(), 'price kinds are read for the studio only').toBe(403)
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
      await acknowledgeGlobalNotices(page)
      await context.addCookies([
        { name: 'auth_token', value: viewer.token, url: baseUrl, sameSite: 'Lax' },
        { name: 'om_selected_tenant', value: scope.tenantId, url: baseUrl, sameSite: 'Lax' },
        { name: 'om_selected_org', value: scope.organizationId, url: baseUrl, sameSite: 'Lax' },
      ])

      const forbidden: string[] = []
      page.on('response', (response) => {
        if (response.status() === 403) forbidden.push(`${response.request().method()} ${response.url()}`)
      })
      await page.goto(MODELS_LIST_URL, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(publishedTitle, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'Create model' })).toHaveCount(0)
      await expect(page.getByRole('columnheader', { name: 'Product' }), 'no catalog product names without catalog.products.view').toHaveCount(0)

      await page.getByText(draftTitle, { exact: true }).click()
      await expect(page, 'an unpublished model has nothing a view-only user may open').toHaveURL(new RegExp(`${MODELS_LIST_URL}$`))
      await expect(page.getByText(/Access denied/)).toHaveCount(0)

      await page.getByText(publishedTitle, { exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`${versionUrl(publishedId, modelVersionId)}$`))
      await expect(page.getByRole('heading', { name: 'Version 1' })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('link', { name: 'Back to models' })).toHaveAttribute('href', MODELS_LIST_URL)
      await expect(page.getByRole('link', { name: 'Back to studio' })).toHaveCount(0)
      expect(forbidden, 'the list and the version page make no request the viewer may not make').toEqual([])

      await page.goto(`${MODELS_LIST_URL}/${publishedId}/versions/not-a-version`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('This published version was not found.')).toBeVisible({ timeout: 30_000 })
    } finally {
      await deleteScopedUser(request, superadminToken, viewer)
      await deleteModelIfExists(request, token, publishedId)
      await deleteModelIfExists(request, token, draftId)
      await deletePriceKindIfExists(request, token, priceKindId)
      await deleteCatalogProductIfExists(request, token, productId)
    }
  })
})

const PRICE_KINDS_PATH = '/api/product_configurator/price-kinds'
const MODEL_MANAGER_FEATURES = ['product_configurator.models.manage', 'catalog.products.view']

/** Catalog price kinds are created tenant-wide over the API; seeding is the only path to an organization-scoped one. */
async function insertOrganizationPriceKind(tenantId: string, organizationId: string, title: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into catalog_price_kinds
         (id, organization_id, tenant_id, code, title, display_mode, currency_code, is_promotion, is_active, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'excluding-tax', 'EUR', false, true, now(), now())
       returning id`,
      [organizationId, tenantId, `qa_pcfg_${uniqueSuffix()}`, title],
    )
    return result.rows[0].id
  })
}

async function deleteInsertedPriceKinds(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withClient(async (client) => {
    await client.query('delete from catalog_price_kinds where id = any($1::uuid[])', [ids])
  })
}

async function listedPriceKindIds(request: APIRequestContext, token: string, query: string): Promise<string[]> {
  const response = await apiRequest(request, 'GET', `${PRICE_KINDS_PATH}?${query}`, { token })
  expect(response.status(), `GET ${PRICE_KINDS_PATH}?${query}`).toBe(200)
  const body = await readJsonSafe<{ items: Array<{ id: string }> }>(response)
  return (body?.items ?? []).map((item) => item.id).sort()
}

test.describe('TC-PCFG-065: a model manager without catalog settings picks price kinds of its own scope', () => {
  test('lists the selected organization and tenant-wide kinds only, and creates a model with one', async ({ request }) => {
    test.setTimeout(180_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const title = (label: string) => `QA PCFG 065 ${suffix} ${label}`
    const insertedKindIds: string[] = []
    let productId: string | null = null
    let tenantKindId: string | null = null
    let foreignTenantKindId: string | null = null
    let siblingOrganizationId: string | null = null
    let foreignTenantId: string | null = null
    let foreignOrganizationId: string | null = null
    let manager: ScopedUser | null = null
    let siblingManager: ScopedUser | null = null
    let foreignCatalogAdmin: ScopedUser | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, adminToken, { title: title('product'), sku: `QA-PCFG-065-K-${suffix}` })
      tenantKindId = await createPriceKindFixture(request, adminToken, 'EUR', title('tenant-wide'))
      siblingOrganizationId = await createOrganizationFixture(request, superadminToken, { name: title('sibling'), tenantId: scope.tenantId })
      const homeKindId = await insertOrganizationPriceKind(scope.tenantId, scope.organizationId, title('home organization'))
      insertedKindIds.push(homeKindId)
      const siblingKindId = await insertOrganizationPriceKind(scope.tenantId, siblingOrganizationId, title('sibling organization'))
      insertedKindIds.push(siblingKindId)

      const tenantResponse = await apiRequest(request, 'POST', '/api/directory/tenants', {
        token: superadminToken,
        data: { name: title('foreign tenant') },
      })
      expect(tenantResponse.status(), 'POST /api/directory/tenants should return 201').toBe(201)
      foreignTenantId = expectId((await readJsonSafe<{ id?: string }>(tenantResponse))?.id, 'Tenant create should return an id')
      foreignOrganizationId = await createOrganizationFixture(request, superadminToken, { name: title('foreign'), tenantId: foreignTenantId })
      foreignCatalogAdmin = await createUserWithFeatures(request, superadminToken, 'foreign-catalog', ['catalog.settings.manage'], {
        tenantId: foreignTenantId,
        organizationId: foreignOrganizationId,
      })
      foreignTenantKindId = await createPriceKindFixture(request, foreignCatalogAdmin.token, 'EUR', title('foreign tenant-wide'))
      const foreignOrganizationKindId = await insertOrganizationPriceKind(foreignTenantId, foreignOrganizationId, title('foreign organization'))
      insertedKindIds.push(foreignOrganizationKindId)

      manager = await createUserWithFeatures(request, superadminToken, 'models-manager', MODEL_MANAGER_FEATURES, scope)
      siblingManager = await createUserWithFeatures(request, superadminToken, 'sibling-manager', MODEL_MANAGER_FEATURES, {
        tenantId: scope.tenantId,
        organizationId: siblingOrganizationId,
      })

      const catalogKinds = await apiRequest(request, 'GET', '/api/catalog/price-kinds?pageSize=1', { token: manager.token })
      expect(catalogKinds.status(), 'the manager has no catalog settings access').toBe(403)

      const allIds = [homeKindId, siblingKindId, tenantKindId, foreignTenantKindId, foreignOrganizationKindId]
      const byIds = `ids=${allIds.join(',')}`
      const bySearch = `search=${encodeURIComponent(`QA PCFG 065 ${suffix}`)}&pageSize=100`
      expect(await listedPriceKindIds(request, manager.token, byIds)).toEqual([homeKindId, tenantKindId].sort())
      expect(await listedPriceKindIds(request, manager.token, bySearch)).toEqual([homeKindId, tenantKindId].sort())
      expect(await listedPriceKindIds(request, siblingManager.token, byIds), 'the sibling organization sees its own kind').toEqual(
        [siblingKindId, tenantKindId].sort(),
      )

      const productRead = await apiRequest(request, 'GET', `/api/catalog/products?ids=${productId}&pageSize=1`, { token: manager.token })
      expect(productRead.status(), 'the create dialog product picker').toBe(200)

      const created = await apiRequest(request, 'POST', MODELS_PATH, {
        token: manager.token,
        data: {
          productId,
          priceKindId: homeKindId,
          modelKey: `qa-pcfg-065-${suffix}`,
          title: title('model'),
          currencyCode: 'EUR',
        },
      })
      expect(created.status(), `POST ${MODELS_PATH} by a model manager`).toBe(201)
      modelId = expectId((await readJsonSafe<{ id?: string }>(created))?.id, 'Model create should return an id')
    } finally {
      await deleteModelIfExists(request, adminToken, modelId)
      await deletePriceKindIfExists(request, foreignCatalogAdmin?.token ?? null, foreignTenantKindId)
      await deleteScopedUser(request, superadminToken, manager)
      await deleteScopedUser(request, superadminToken, siblingManager)
      await deleteScopedUser(request, superadminToken, foreignCatalogAdmin)
      await deleteInsertedPriceKinds(insertedKindIds)
      await deletePriceKindIfExists(request, adminToken, tenantKindId)
      await deleteCatalogProductIfExists(request, adminToken, productId)
      await deleteOrganizationIfExists(request, superadminToken, siblingOrganizationId)
      await deleteOrganizationIfExists(request, superadminToken, foreignOrganizationId)
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/directory/tenants', foreignTenantId)
    }
  })
})

test.describe('TC-PCFG-065: a model manager without currencies.view creates a model in the dialog', () => {
  test.use({ actionTimeout: 15_000 })

  test('types the currency, makes no forbidden request, shows no access toast and opens the studio', async ({ page, context, request }) => {
    test.setTimeout(180_000)
    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const productTitle = `QA PCFG 065 dialog ${suffix}`
    const priceKindTitle = `QA PCFG 065 dialog kind ${suffix}`
    let productId: string | null = null
    let priceKindId: string | null = null
    let manager: ScopedUser | null = null
    let modelId: string | null = null

    try {
      productId = await createUnitProductFixture(request, adminToken, { title: productTitle, sku: `QA-PCFG-065-D-${suffix}` })
      priceKindId = await createPriceKindFixture(request, adminToken, 'EUR', priceKindTitle)
      manager = await createUserWithFeatures(
        request,
        superadminToken,
        'models-admin',
        ['product_configurator.models.view', ...MODEL_MANAGER_FEATURES],
        scope,
      )
      const currencies = await apiRequest(request, 'GET', '/api/currencies/currencies/options?limit=1', { token: manager.token })
      expect(currencies.status(), 'the manager has no currencies.view').toBe(403)

      const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
      await acknowledgeGlobalNotices(page)
      await context.addCookies([
        { name: 'auth_token', value: manager.token, url: baseUrl, sameSite: 'Lax' },
        { name: 'om_selected_tenant', value: scope.tenantId, url: baseUrl, sameSite: 'Lax' },
        { name: 'om_selected_org', value: scope.organizationId, url: baseUrl, sameSite: 'Lax' },
      ])
      const forbidden: string[] = []
      const currencyRequests: string[] = []
      page.on('response', (response) => {
        if (response.status() === 403) forbidden.push(`${response.request().method()} ${response.url()}`)
      })
      page.on('request', (sent) => {
        if (sent.url().includes('/api/currencies/')) currencyRequests.push(sent.url())
      })

      await page.goto(MODELS_LIST_URL, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Create model' }).first().click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Create configuration model')).toBeVisible()
      await dialog.locator('[data-crud-field-id="title"] input').fill(`QA PCFG 065 dialog model ${suffix}`)
      await dialog.locator('[data-crud-field-id="modelKey"] input').fill(`qa-pcfg-065-d-${suffix}`)
      await page.getByRole('combobox', { name: 'Search products', exact: true }).fill(productTitle)
      await page.getByRole('option', { name: new RegExp(`^${productTitle}`) }).first().click()
      const currency = dialog.getByRole('combobox', { name: 'EUR', exact: true })
      await currency.fill('EUR')
      await currency.press('Enter')
      await page.getByRole('combobox', { name: 'Select a price kind', exact: true }).fill(suffix)
      await page.getByRole('option', { name: new RegExp(`^${priceKindTitle}`) }).first().click()
      await dialog.getByRole('button', { name: 'Create model' }).click()

      await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })
      const match = new URL(page.url()).pathname.match(/models\/([0-9a-f-]{36})$/)
      modelId = match?.[1] ?? null
      expect(modelId, 'the create dialog opens the studio of the new model').toBeTruthy()
      const created = await readModel(request, adminToken, modelId ?? '')
      expect(created.currencyCode).toBe('EUR')
      await expect(page.getByText(/Access denied/)).toHaveCount(0)
      expect(currencyRequests, 'no currency options are requested without currencies.view').toEqual([])
      expect(forbidden, 'the dialog makes no request the manager may not make').toEqual([])
    } finally {
      await deleteModelIfExists(request, adminToken, modelId)
      await deleteScopedUser(request, superadminToken, manager)
      await deletePriceKindIfExists(request, adminToken, priceKindId)
      await deleteCatalogProductIfExists(request, adminToken, productId)
    }
  })
})
