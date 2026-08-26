import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from './api'
import { deleteStaffEntityIfExists } from './staffFixtures'

export async function createTimeProjectFixture(
  request: APIRequestContext,
  token: string,
  input?: { name?: string; code?: string },
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/staff/timesheets/time-projects', {
    token,
    data: {
      name: input?.name ?? `QA Project ${Date.now()}`,
      code: input?.code ?? `QA-${Date.now()}`,
      projectType: 'internal',
      status: 'active',
    },
  })
  expect(response.ok(), `Failed to create time project fixture: ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as { id?: string }
  expect(typeof body.id === 'string' && body.id.length > 0).toBeTruthy()
  return body.id as string
}

export async function assignEmployeeToProjectFixture(
  request: APIRequestContext,
  token: string,
  projectId: string,
  staffMemberId: string,
): Promise<string> {
  const response = await apiRequest(request, 'POST', `/api/staff/timesheets/time-projects/${projectId}/employees`, {
    token,
    data: { staffMemberId, status: 'active', assignedStartDate: new Date().toISOString().slice(0, 10) },
  })
  expect(response.ok(), `Failed to assign employee to project: ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as { id?: string }
  return body.id ?? ''
}

export async function createTimeEntryFixture(
  request: APIRequestContext,
  token: string,
  input: { staffMemberId: string; timeProjectId: string; date: string; durationMinutes: number },
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/staff/timesheets/time-entries', {
    token,
    data: {
      staffMemberId: input.staffMemberId,
      timeProjectId: input.timeProjectId,
      date: input.date,
      durationMinutes: input.durationMinutes,
      source: 'manual',
    },
  })
  expect(response.ok(), `Failed to create time entry fixture: ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as { id?: string }
  expect(typeof body.id === 'string' && body.id.length > 0).toBeTruthy()
  return body.id as string
}

export async function getSelfStaffMemberId(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  const response = await apiRequest(request, 'GET', '/api/staff/team-members/self', { token })
  expect(response.ok(), 'GET /api/staff/team-members/self should succeed').toBeTruthy()
  const body = (await response.json()) as { member?: { id?: string } }
  const staffMemberId = body.member?.id ?? ''
  expect(staffMemberId.length > 0, 'Caller must have a staff member profile').toBeTruthy()
  return staffMemberId
}

/**
 * Stops every timer currently running for the member.
 *
 * Timer state is per-member and survives across specs, so a suite that asserts
 * the not-running branch must clear it first rather than assume it.
 */
export async function stopRunningTimers(
  request: APIRequestContext,
  token: string,
  staffMemberId: string,
): Promise<void> {
  const response = await apiRequest(
    request,
    'GET',
    `/api/staff/timesheets/time-entries?staffMemberId=${encodeURIComponent(staffMemberId)}&running=true&pageSize=50`,
    { token },
  )
  if (!response.ok()) return
  const body = (await response.json()) as { items?: Array<{ id?: string }> }
  for (const entry of body.items ?? []) {
    if (!entry.id) continue
    await apiRequest(
      request,
      'POST',
      `/api/staff/timesheets/time-entries/${encodeURIComponent(entry.id)}/timer-stop`,
      { token },
    ).catch(() => {})
  }
}

export async function startTimerFixture(
  request: APIRequestContext,
  token: string,
  input: { staffMemberId: string; timeProjectId: string; date: string; notes?: string | null },
): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/staff/timesheets/time-entries/start-timer', {
    token,
    data: {
      staffMemberId: input.staffMemberId,
      timeProjectId: input.timeProjectId,
      date: input.date,
      notes: input.notes ?? null,
    },
  })
  expect(response.ok(), `Failed to start timer fixture: ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as { id?: string }
  expect(typeof body.id === 'string' && body.id.length > 0).toBeTruthy()
  return body.id as string
}

export async function readTimesheetPreference(
  request: APIRequestContext,
  token: string,
): Promise<{ lastProjectId: string | null; updatedAt: string | null }> {
  const response = await apiRequest(request, 'GET', '/api/staff/timesheets/my-preferences', { token })
  expect(response.ok(), `GET my-preferences should succeed: ${response.status()}`).toBeTruthy()
  return (await response.json()) as { lastProjectId: string | null; updatedAt: string | null }
}

export async function setTimesheetPreference(
  request: APIRequestContext,
  token: string,
  lastProjectId: string | null,
) {
  return apiRequest(request, 'PUT', '/api/staff/timesheets/my-preferences', {
    token,
    data: { lastProjectId },
  })
}

export { deleteStaffEntityIfExists }
