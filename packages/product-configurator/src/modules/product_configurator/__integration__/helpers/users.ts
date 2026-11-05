import type { APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './fixtures'

export type ScopedUser = { token: string; userId: string; roleId: string }

const PASSWORD = 'StrongSecret123!'

/** A user whose only grants are `features`, in the caller's home organization unless `scope` names another one. */
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
  await setRoleAclFeatures(request, superadminToken, { roleId, features, organizations: null })
  const email = `qa-pcfg-${label}-${suffix}@example.com`
  const userId = await createUserFixture(request, superadminToken, {
    email,
    password: PASSWORD,
    organizationId,
    roles: [roleId],
    name: `QA PCFG ${label}`,
  })
  const token = await getAuthToken(request, email, PASSWORD)
  return { token, userId, roleId }
}

export async function deleteScopedUser(request: APIRequestContext, superadminToken: string, user: ScopedUser | null): Promise<void> {
  if (!user) return
  await deleteUserIfExists(request, superadminToken, user.userId)
  await deleteRoleIfExists(request, superadminToken, user.roleId)
}
