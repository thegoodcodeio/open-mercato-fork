/**
 * @jest-environment jsdom
 */
// The timesheet's load used to be one sequential chain of throwing reads: a single
// failing endpoint took the whole period down, flashed once, and left a screen that
// was indistinguishable from an empty week. The assignment list and the entry pages
// are now settled independently, so a partial answer renders as data plus a banner,
// and only a total failure gets the unavailable state. Both carry a retry.

import * as React from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useSearchParams } from 'next/navigation'
import { todayIso } from '../../../../../lib/time-tracking-ui/timesheetPeriod'
import TimesheetPage from '../page'

const STAFF_MEMBER_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: jest.fn(),
}))

const mockTranslate = (key: string, fallback?: string | Record<string, string | number>): string =>
  typeof fallback === 'string' ? fallback : key

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({ useT: () => mockTranslate }))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 1,
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({ useBackendChrome: jest.fn() }))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({ useConfirmDialog: jest.fn() }))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
    retryLastMutation: jest.fn(async () => true),
  }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => {
  const actual = jest.requireActual('@open-mercato/ui/backend/utils/apiCall')
  return { ...actual, apiCall: jest.fn(), apiCallOrThrow: jest.fn(), readApiResultOrThrow: jest.fn() }
})

jest.mock('../../../../../lib/timesheets-ui/TimerBar', () => ({ TimerBar: () => null }))
jest.mock('../../../../../lib/timesheets-ui/CreateProjectDialog', () => ({ CreateProjectDialog: () => null }))
jest.mock('../../../../../lib/time-tracking-ui/TimeEntryDialog', () => ({ TimeEntryDialog: () => null }))
jest.mock('../../../../../lib/timesheets-ui/ListView', () => ({
  ListView: () => <div data-testid="list-view" />,
}))
jest.mock('../../../../../lib/time-tracking-ui/TimesheetCalendar', () => ({
  TimesheetCalendar: () => <div data-testid="calendar-view" />,
}))
jest.mock('../../../../../lib/time-tracking-ui/TimesheetPeriodFooter', () => ({
  TimesheetPeriodFooter: () => null,
}))
jest.mock('../../../../../lib/time-tracking-ui/PeriodSelector', () => ({
  PeriodSelector: () => null,
  TimesheetFilterSelect: () => null,
}))
jest.mock('../../../../../lib/time-tracking-ui/TimesheetViewSwitch', () => ({
  TimesheetViewSwitch: () => null,
}))
jest.mock('../GridView', () => ({ GridView: () => <div data-testid="grid-view" /> }))

const readApiResultMock = readApiResultOrThrow as jest.MockedFunction<typeof readApiResultOrThrow>
const useBackendChromeMock = useBackendChrome as jest.MockedFunction<typeof useBackendChrome>
const useConfirmDialogMock = useConfirmDialog as jest.MockedFunction<typeof useConfirmDialog>
const useSearchParamsMock = useSearchParams as jest.MockedFunction<typeof useSearchParams>

const PARTIAL_MESSAGE = 'Some timesheet data could not be loaded. Try again.'
const UNAVAILABLE_MESSAGE = 'Timesheet data is temporarily unavailable.'

type Failing = { assignments?: boolean; entries?: boolean }

/**
 * Every read answers unless this run marks it failing, so each test names only the
 * endpoint it is knocking over.
 */
function stubReads(failing: Failing = {}): void {
  readApiResultMock.mockImplementation(async (url) => {
    const href = String(url)
    if (href.startsWith('/api/staff/team-members/self')) {
      return { member: { id: STAFF_MEMBER_ID } } as never
    }
    if (href.startsWith('/api/staff/timesheets/my-projects')) {
      if (failing.assignments) throw new Error('assignments unavailable')
      return { items: [{ time_project_id: PROJECT_ID, show_in_grid: true }] } as never
    }
    if (href.startsWith('/api/staff/timesheets/time-entries')) {
      if (failing.entries) throw new Error('entries unavailable')
      return {
        items: [
          {
            id: ENTRY_ID,
            date: todayIso(),
            time_project_id: PROJECT_ID,
            duration_minutes: 60,
            staff_member_id: STAFF_MEMBER_ID,
          },
        ],
        totalPages: 1,
      } as never
    }
    if (href.startsWith('/api/staff/timesheets/time-projects')) {
      return { items: [{ id: PROJECT_ID, name: 'Apollo', code: 'APL', color: null }] } as never
    }
    if (href.startsWith('/api/staff/timesheets/settings')) {
      return { targets: { dailyHours: null } } as never
    }
    return {} as never
  })
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TimesheetPage />)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  useBackendChromeMock.mockReturnValue({
    payload: { grantedFeatures: ['staff.timesheets.manage_own'] },
    isLoading: false,
    isReady: true,
    refresh: jest.fn(),
  } as unknown as ReturnType<typeof useBackendChrome>)
  useConfirmDialogMock.mockReturnValue({
    confirm: jest.fn(async () => true),
    ConfirmDialogElement: null,
  } as unknown as ReturnType<typeof useConfirmDialog>)
  useSearchParamsMock.mockReturnValue(
    new URLSearchParams('view=grid') as unknown as ReturnType<typeof useSearchParams>,
  )
})

describe('timesheet progressive load', () => {
  it('renders the period with a banner when only the assignment read fails', async () => {
    stubReads({ assignments: true })

    await renderPage()

    // The entries answered, so the view is still on screen — the banner reports
    // what is missing rather than replacing everything with an error.
    expect(screen.getByTestId('grid-view')).toBeInTheDocument()
    expect(screen.getByText(PARTIAL_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).not.toBeInTheDocument()
  })

  it('renders the period with a banner when only the entry read fails', async () => {
    stubReads({ entries: true })

    await renderPage()

    expect(screen.getByTestId('grid-view')).toBeInTheDocument()
    expect(screen.getByText(PARTIAL_MESSAGE)).toBeInTheDocument()
  })

  it('shows the unavailable state, not an empty period, when nothing loads', async () => {
    stubReads({ assignments: true, entries: true })

    await renderPage()

    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument()
  })

  it('clears the failure state when a retry succeeds', async () => {
    stubReads({ assignments: true, entries: true })
    await renderPage()
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument()

    stubReads()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(PARTIAL_MESSAGE)).not.toBeInTheDocument()
    expect(screen.getByTestId('grid-view')).toBeInTheDocument()
  })

  it('keeps a healthy load free of both failure states', async () => {
    stubReads()

    await renderPage()

    expect(screen.getByTestId('grid-view')).toBeInTheDocument()
    expect(screen.queryByText(PARTIAL_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).not.toBeInTheDocument()
  })
})
