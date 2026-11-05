import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { MODELS_PATH } from './helpers/fixtures'

test.describe('TC-PCFG-007: module enabled on a fresh database', () => {
  test('the migrations are applied and GET /models answers with a paged list', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    const response = await apiRequest(request, 'GET', `${MODELS_PATH}?pageSize=5`, { token })

    expect(response.status()).toBe(200)
    const body = await readJsonSafe<{ items?: unknown[]; total?: number }>(response)
    expect(Array.isArray(body?.items)).toBe(true)
    expect(typeof body?.total).toBe('number')
  })
})
