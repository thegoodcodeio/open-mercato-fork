import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { LOCK_HEADER } from './fixtures'
import { cancelSession, evaluateOk, openSession, readSession, SESSIONS_PATH, type Cleanup, type EvaluateResult } from './sessions'

export const LINES_UPDATE_PATH = '/api/product_configurator/lines/update'

export type MigrationItem = { featureKey: string; label: string; oldValue: unknown; oldDisplay: unknown; reason: string }
export type SelectionMigration = {
  fromVersion: { id: string; version: number }
  toVersion: { id: string; version: number }
  kept: MigrationItem[]
  dropped: MigrationItem[]
  reset: MigrationItem[]
}
export type CopyOpened = {
  sessionId: string
  revision: number
  mode: string
  sourceSnapshotId: string | null
  modelVersion: { id: string; version: number }
  migration: SelectionMigration | null
}

/** Opens a copy of a snapshot ("Add another identical", "Configure again") and registers its cancellation. */
export async function openCopy(
  request: APIRequestContext,
  token: string,
  cleanup: Cleanup,
  data: { quoteId: string; fromSnapshotId: string; mode?: string },
): Promise<CopyOpened> {
  const response = await openSession(request, token, data)
  expect(response.status(), `POST ${SESSIONS_PATH} (copy) should return 201: ${await response.text()}`).toBe(201)
  const body = (await readJsonSafe<CopyOpened>(response)) as CopyOpened
  cleanup.add(() => cancelSession(request, token, body.sessionId))
  return body
}

/** The first evaluate of a copy sends the selections the session was opened with, as the workspace does. */
export async function evaluateStoredSelections(request: APIRequestContext, token: string, sessionId: string): Promise<EvaluateResult> {
  const session = await readJsonSafe<{ revision: number; selections: Record<string, unknown> }>(await readSession(request, token, `id=${sessionId}`))
  return evaluateOk(request, token, { id: sessionId, revision: session?.revision ?? 0, selections: session?.selections ?? {} })
}

export function updateLine(
  request: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
  quoteUpdatedAt?: string | null,
  options: { selectedOrgId?: string } = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = {}
  if (quoteUpdatedAt) headers[LOCK_HEADER] = quoteUpdatedAt
  if (options.selectedOrgId) headers.Cookie = `om_selected_org=${options.selectedOrgId}`
  return apiRequest(request, 'POST', LINES_UPDATE_PATH, { token, data, headers })
}
