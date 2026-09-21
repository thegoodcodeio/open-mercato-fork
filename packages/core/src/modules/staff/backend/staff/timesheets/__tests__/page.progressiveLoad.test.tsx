/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MyTimesheetsPage from '../page'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { REQUEST_TIMEOUT_MS } from '../../../../lib/timesheets-ui/readApiResultWithTimeout'

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

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(async () => ({ ok: true, status: 200, result: { ok: true, granted: [] }, response: {} })),
  apiCallOrThrow: jest.fn(async () => ({})),
  readApiResultOrThrow: jest.fn(),
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({ runMutation: jest.fn(), retryLastMutation: jest.fn() }),
}))

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
  ErrorMessage: ({ label, action }: { label?: string; action?: React.ReactNode }) => (
    <div>
      <p>{label}</p>
      {action}
    </div>
  ),
}))

jest.mock('@open-mercato/ui/primitives/button', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => <button {...rest}>{children}</button>,
}))

jest.mock('../../../../lib/timesheets-ui/ViewSwitcher', () => ({ ViewSwitcher: () => null }))
jest.mock('../../../../lib/timesheets-ui/CalendarPicker', () => ({ CalendarPicker: () => null }))
jest.mock('../../../../lib/timesheets-ui/ListView', () => ({ ListView: () => null }))
jest.mock('../../../../lib/timesheets-ui/TimerBar', () => ({ TimerBar: () => null }))
jest.mock('../../../../lib/timesheets-ui/AddRowDropdown', () => ({ AddRowDropdown: () => null }))
jest.mock('../../../../lib/timesheets-ui/CreateProjectDialog', () => ({ CreateProjectDialog: () => null }))
jest.mock('../../../../lib/timesheets-ui/ProjectColorDot', () => ({ ProjectColorDot: () => null }))

type Route = 'self' | 'myProjects' | 'timeProjects' | 'timeEntries'
type RouteFailure = Error | 'hang'

const ROUTE_PATHS: Record<Route, string> = {
  self: '/api/staff/team-members/self',
  myProjects: '/api/staff/timesheets/my-projects',
  timeProjects: '/api/staff/timesheets/time-projects',
  timeEntries: '/api/staff/timesheets/time-entries',
}

const ROUTE_RESULTS: Record<Route, unknown> = {
  self: { member: { id: 'member-1', displayName: 'Tester' } },
  myProjects: { items: [{ time_project_id: 'project-1', show_in_grid: true }] },
  timeProjects: { items: [{ id: 'project-1', name: 'Build', code: 'BLD', color: null }] },
  timeEntries: { items: [] },
}

const PARTIAL_LOAD_MESSAGE = 'Some timesheet data could not be loaded. Try again.'
const UNAVAILABLE_MESSAGE = 'Timesheet data is temporarily unavailable.'
const LOAD_ERROR_MESSAGE = 'Failed to load timesheets.'

const readApiResultOrThrowMock = readApiResultOrThrow as jest.Mock
const flashMock = flash as jest.Mock
const mockLogger = (
  jest.requireMock('@open-mercato/shared/lib/logger') as { createLogger: () => { error: jest.Mock } }
).createLogger()

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function routeOf(url: string): Route | null {
  const match = (Object.keys(ROUTE_PATHS) as Route[]).find((route) => url.includes(ROUTE_PATHS[route]))
  return match ?? null
}

function stubReads(failures: Partial<Record<Route, RouteFailure>> = {}): void {
  readApiResultOrThrowMock.mockImplementation((url: string, init?: RequestInit) => {
    const route = routeOf(String(url))
    const failure = route ? failures[route] : undefined
    if (failure === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()))
      })
    }
    if (failure) return Promise.reject(failure)
    return Promise.resolve(route ? ROUTE_RESULTS[route] : { items: [] })
  })
}

function readsOf(route: Route): number {
  return readApiResultOrThrowMock.mock.calls.filter(([url]) => String(url).includes(ROUTE_PATHS[route])).length
}

function projectCells(): HTMLElement[] {
  return screen.queryAllByRole('textbox', { name: /^Duration for Build on / })
}

describe('MyTimesheetsPage — progressive loading and retry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    stubReads()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders the loaded projects with a partial-load message when only the entries fail, and retries the reads', async () => {
    stubReads({ timeEntries: new Error('HTTP 500') })
    render(<MyTimesheetsPage />)

    expect(await screen.findByText(PARTIAL_LOAD_MESSAGE)).toBeInTheDocument()
    expect(projectCells().length).toBeGreaterThan(0)
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).not.toBeInTheDocument()

    const entryReadsBeforeRetry = readsOf('timeEntries')
    stubReads()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(readsOf('timeEntries')).toBe(entryReadsBeforeRetry + 1))
    await waitFor(() => expect(screen.queryByText(PARTIAL_LOAD_MESSAGE)).not.toBeInTheDocument())
    expect(projectCells().length).toBeGreaterThan(0)
  })

  it('shows a single unavailable state with one Retry when neither projects nor entries load', async () => {
    stubReads({ timeProjects: new Error('HTTP 500'), timeEntries: new Error('HTTP 500') })
    render(<MyTimesheetsPage />)

    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument()
    expect(screen.getAllByText(UNAVAILABLE_MESSAGE)).toHaveLength(1)
    expect(screen.queryByText(PARTIAL_LOAD_MESSAGE)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(projectCells()).toHaveLength(0)
  })

  it('surfaces the load error when the team-member lookup fails', async () => {
    const failure = new Error('HTTP 500')
    stubReads({ self: failure })
    render(<MyTimesheetsPage />)

    await waitFor(() => expect(flashMock).toHaveBeenCalledWith(LOAD_ERROR_MESSAGE, 'error'))
    expect(mockLogger.error).toHaveBeenCalledWith('staff.timesheets.my.load', { err: failure })
    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(readsOf('timeEntries')).toBe(0)
  })

  it('settles a hung entries read into the partial-load state once the request timeout elapses', async () => {
    jest.useFakeTimers()
    stubReads({ timeEntries: 'hang' })
    render(<MyTimesheetsPage />)

    await waitFor(() => expect(readsOf('timeEntries')).toBe(1))
    expect(screen.getByText('Loading your projects and entries...')).toBeInTheDocument()
    expect(screen.queryByText(PARTIAL_LOAD_MESSAGE)).not.toBeInTheDocument()

    await act(async () => {
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS)
    })

    expect(await screen.findByText(PARTIAL_LOAD_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText('Loading your projects and entries...')).not.toBeInTheDocument()
    expect(projectCells().length).toBeGreaterThan(0)
  })
})
