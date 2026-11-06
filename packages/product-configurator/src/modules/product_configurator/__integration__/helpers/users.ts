import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { deleteGeneralEntityIfExists, expectId, getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './fixtures'

export type ScopedUser = { token: string; userId: string; roleId: string }

const PASSWORD = 'StrongSecret123!'

/**
 * A user whose only grants are `features`, in the caller's home organization unless `scope` names another one.
 * When a later step fails, what was already created is deleted before the error is rethrown, because the
 * caller never receives it to clean up.
 */
export async function createUserWithFeatures(
  request: APIRequestContext,
  superadminToken: string,
  label: string,
  features: string[],
  scope?: { tenantId: string; organizationId: string },
): Promise<ScopedUser> {
  const { organizationId, tenantId } = scope ?? getTokenContext(superadminToken)
  const suffix = uniqueSuffix()
  const roleId = await createRoleFixture(request, superadminToken, { name: `qa-pcfg-${label}-${suffix}`, tenantId })
  let userId: string | null = null
  try {
    await setRoleAclFeatures(request, superadminToken, { roleId, features, organizations: null })
    const email = `qa-pcfg-${label}-${suffix}@example.com`
    userId = await createUserFixture(request, superadminToken, {
      email,
      password: PASSWORD,
      organizationId,
      roles: [roleId],
      name: `QA PCFG ${label}`,
    })
    const token = await getAuthToken(request, email, PASSWORD)
    return { token, userId, roleId }
  } catch (error) {
    if (userId) await deleteUserIfExists(request, superadminToken, userId).catch(() => undefined)
    await deleteRoleIfExists(request, superadminToken, roleId).catch(() => undefined)
    throw error
  }
}

export async function deleteScopedUser(request: APIRequestContext, superadminToken: string, user: ScopedUser | null): Promise<void> {
  if (!user) return
  await deleteUserIfExists(request, superadminToken, user.userId)
  await deleteRoleIfExists(request, superadminToken, user.roleId)
}

export type ForeignTenant = { tenantId: string; organizationId: string }

const TENANTS_PATH = '/api/directory/tenants'

/** A second tenant with one organization, for cross-tenant checks. A half-created tenant is deleted before the error is rethrown. */
export async function createForeignTenant(request: APIRequestContext, superadminToken: string, label: string): Promise<ForeignTenant> {
  const response = await apiRequest(request, 'POST', TENANTS_PATH, { token: superadminToken, data: { name: `QA PCFG ${label} ${uniqueSuffix()}` } })
  expect(response.status(), `POST ${TENANTS_PATH} failed: ${await response.text()}`).toBe(201)
  const tenantId = expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'tenant id')
  try {
    const organizationId = await createOrganizationFixture(request, superadminToken, { name: `QA PCFG ${label} ${uniqueSuffix()}`, tenantId })
    return { tenantId, organizationId }
  } catch (error) {
    await deleteGeneralEntityIfExists(request, superadminToken, TENANTS_PATH, tenantId)
    throw error
  }
}

export async function deleteForeignTenant(request: APIRequestContext, superadminToken: string, tenant: ForeignTenant | null): Promise<void> {
  if (!tenant) return
  await deleteOrganizationIfExists(request, superadminToken, tenant.organizationId)
  await deleteGeneralEntityIfExists(request, superadminToken, TENANTS_PATH, tenant.tenantId)
}
