/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import TimesheetProjectsPage from '../page'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const translate = (_key: string, fallback?: string) => fallback ?? _key
  return { useT: () => translate }
})

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 0,
}))

// The page creates its logger at import time, before any top-level `const` in this
// file is initialised, so the shared instance lives inside the factory.
jest.mock('@open-mercato/shared/lib/logger', () => {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  return { createLogger: () => logger }
})

jest.mock('@open-mercato/shared/lib/time', () => ({ formatDateTime: () => null }))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: jest.fn(),
  withScopedApiRequestHeaders: jest.fn(),
}))

jest.mock('@open-mercato/ui/backend/utils/optimisticLock', () => ({ buildOptimisticLockHeader: jest.fn() }))
jest.mock('@open-mercato/ui/backend/conflicts', () => ({ surfaceRecordConflict: jest.fn() }))
jest.mock('@open-mercato/ui/backend/utils/crud', () => ({ deleteCrud: jest.fn() }))
jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(async () => true), ConfirmDialogElement: null }),
}))

jest.mock('@open-mercato/ui/backend/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PageBody: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label?: string }) => <div>{label}</div>,
}))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: ({ title, actions }: { title?: string; actions?: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      <div>{actions}</div>
    </section>
  ),
  withDataTableNamespaces: (row: Record<string, unknown>) => row,
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({ RowActions: () => null }))

jest.mock('@open-mercato/ui/primitives/button', () => ({
  Button: ({
    children,
    asChild,
    ...rest
  }: React.ComponentProps<'button'> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
}))

jest.mock('../../../../../lib/timesheets-ui/ProjectColorDot', () => ({ ProjectColorDot: () => null }))
jest.mock('../../../../../lib/timesheets-ui/colors', () => ({ resolveProjectColorHex: () => '#000000' }))
jest.mock('../../../../../lib/timesheets-projects-ui/ProjectsKpiStrip', () => ({ ProjectsKpiStrip: () => null }))
jest.mock('../../../../../lib/timesheets-projects-ui/SavedViewTabs', () => ({
  SavedViewTabs: ({ tabs, ariaLabel }: { tabs: Array<{ id: string; label: string }>; ariaLabel?: string }) => (
    <ul aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <li key={tab.id}>{tab.label}</li>
      ))}
    </ul>
  ),
}))
jest.mock('../../../../../lib/timesheets-projects-ui/HoursSparkline', () => ({ HoursSparkline: () => null }))
jest.mock('../../../../../lib/timesheets-projects-ui/ProjectMembersAvatarStack', () => ({
  ProjectMembersAvatarStack: () => null,
}))
jest.mock('../../../../../lib/timesheets-projects-ui/ViewModeToggle', () => ({ ViewModeToggle: () => null }))
jest.mock('../../../../../lib/timesheets-projects-ui/useProjectsViewMode', () => ({
  useProjectsViewMode: () => ['table', jest.fn()],
}))
jest.mock('../../../../../lib/timesheets-projects-ui/ProjectCard', () => ({ ProjectCard: () => null }))

const MANAGE_FEATURE = 'staff.timesheets.projects.manage'
const FEATURE_CHECK_URL = '/api/auth/feature-check'
const KPIS_URL = '/api/staff/timesheets/projects/kpis'
const PROJECTS_URL = '/api/staff/timesheets/time-projects'
const CREATE_HREF = '/backend/staff/timesheets/projects/create'
const CHECKING_MESSAGE = 'Checking your project permissions...'

const COLLAB_KPIS = {
  role: 'collab',
  myProjects: { count: 1, active: 1 },
  myHoursWeek: { value: 0, previous: 0 },
  myHoursMonth: { value: 0, previous: 0 },
}

const readApiResultOrThrowMock = readApiResultOrThrow as jest.Mock
const flashMock = flash as jest.Mock
const mockLogger = (
  jest.requireMock('@open-mercato/shared/lib/logger') as { createLogger: () => { error: jest.Mock } }
).createLogger()

type FeatureCheck = { granted: string[] } | Error | Promise<{ granted: string[] }>

function stubReads(featureCheck: FeatureCheck): void {
  readApiResultOrThrowMock.mockImplementation((url: string) => {
    if (url === FEATURE_CHECK_URL) {
      if (featureCheck instanceof Error) return Promise.reject(featureCheck)
      return Promise.resolve(featureCheck)
    }
    if (url === KPIS_URL) return Promise.resolve(COLLAB_KPIS)
    if (url.startsWith(PROJECTS_URL)) return Promise.resolve({ items: [], total: 0, totalPages: 1 })
    return Promise.resolve({})
  })
}

function callsTo(prefix: string): string[] {
  return readApiResultOrThrowMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith(prefix))
}

function lastProjectsQuery(): URLSearchParams {
  const urls = callsTo(PROJECTS_URL)
  return new URLSearchParams(urls[urls.length - 1]?.split('?')[1] ?? '')
}

function addProjectLink(): HTMLElement | null {
  return screen.queryByRole('link', { name: 'Add Project' })
}

function savedViewLabels(): string[] {
  const list = screen.getByRole('list', { name: 'Saved views' })
  return within(list).getAllByRole('listitem').map((item) => item.textContent ?? '')
}

describe('TimesheetProjectsPage — manage permission from the feature check', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('grants manager affordances from the feature check even when the KPI payload says collaborator', async () => {
    stubReads({ granted: [MANAGE_FEATURE] })
    render(<TimesheetProjectsPage />)

    const link = await screen.findByRole('link', { name: 'Add Project' })
    expect(link).toHaveAttribute('href', CREATE_HREF)
    await waitFor(() => expect(callsTo(KPIS_URL)).toHaveLength(1))
    await waitFor(() => expect(callsTo(PROJECTS_URL).length).toBeGreaterThan(0))

    expect(savedViewLabels()).toEqual(['All', 'Active', 'On Hold', 'Completed', 'Mine'])
    expect(lastProjectsQuery().get('mine')).toBeNull()
    expect(flashMock).not.toHaveBeenCalled()
  })

  it('hides manager affordances and scopes the list to the member when the feature is denied', async () => {
    stubReads({ granted: [] })
    render(<TimesheetProjectsPage />)

    await waitFor(() => expect(callsTo(PROJECTS_URL).length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByText(CHECKING_MESSAGE)).not.toBeInTheDocument())

    expect(addProjectLink()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Project' })).not.toBeInTheDocument()
    expect(savedViewLabels()).toEqual(['All', 'Active', 'Completed'])
    expect(lastProjectsQuery().get('mine')).toBe('1')
    expect(flashMock).not.toHaveBeenCalled()
  })

  it('holds the KPI and project loads behind a pending feature check and shows a disabled Add Project', async () => {
    let resolveFeatureCheck: (value: { granted: string[] }) => void = () => {}
    stubReads(
      new Promise<{ granted: string[] }>((resolve) => {
        resolveFeatureCheck = resolve
      }),
    )
    render(<TimesheetProjectsPage />)
    await act(async () => {})

    expect(screen.getByText(CHECKING_MESSAGE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeDisabled()
    expect(addProjectLink()).not.toBeInTheDocument()
    expect(callsTo(FEATURE_CHECK_URL)).toHaveLength(1)
    expect(callsTo(KPIS_URL)).toHaveLength(0)
    expect(callsTo(PROJECTS_URL)).toHaveLength(0)

    await act(async () => {
      resolveFeatureCheck({ granted: [MANAGE_FEATURE] })
    })

    await waitFor(() => expect(callsTo(KPIS_URL)).toHaveLength(1))
    await waitFor(() => expect(callsTo(PROJECTS_URL).length).toBeGreaterThan(0))
    expect(await screen.findByRole('link', { name: 'Add Project' })).toBeInTheDocument()
    expect(screen.queryByText(CHECKING_MESSAGE)).not.toBeInTheDocument()
  })

  it('logs and surfaces a failed feature check instead of silently treating it as denied', async () => {
    const failure = new Error('HTTP 503')
    stubReads(failure)
    render(<TimesheetProjectsPage />)

    await waitFor(() =>
      expect(mockLogger.error).toHaveBeenCalledWith('staff.timesheets.projects.permissions', { err: failure }),
    )
    await waitFor(() => expect(flashMock).toHaveBeenCalledWith('Failed to load projects.', 'error'))
    await waitFor(() => expect(callsTo(PROJECTS_URL).length).toBeGreaterThan(0))

    expect(addProjectLink()).not.toBeInTheDocument()
    expect(lastProjectsQuery().get('mine')).toBe('1')
  })
})
