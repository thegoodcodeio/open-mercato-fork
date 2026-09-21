/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MyTimesheetsPage from '../page'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import {
  clampDateToMonth,
  getDaysInMonth,
  getMonday,
} from '../../../../lib/timesheets-ui/dateAnchor'

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const translate = (_key: string, fallback?: string) => fallback ?? _key
  return { useT: () => translate }
})

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 0,
}))

jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}))

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
  ErrorMessage: ({ label }: { label?: string }) => <div>{label}</div>,
}))

jest.mock('@open-mercato/ui/primitives/button', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => <button {...rest}>{children}</button>,
}))

jest.mock('../../../../lib/timesheets-ui/CalendarPicker', () => ({ CalendarPicker: () => null }))
jest.mock('../../../../lib/timesheets-ui/ListView', () => ({ ListView: () => null }))
jest.mock('../../../../lib/timesheets-ui/TimerBar', () => ({ TimerBar: () => null }))
jest.mock('../../../../lib/timesheets-ui/AddRowDropdown', () => ({ AddRowDropdown: () => null }))
jest.mock('../../../../lib/timesheets-ui/CreateProjectDialog', () => ({ CreateProjectDialog: () => null }))
jest.mock('../../../../lib/timesheets-ui/ProjectColorDot', () => ({ ProjectColorDot: () => null }))

const readApiResultOrThrowMock = readApiResultOrThrow as jest.Mock

// Only `Date` is faked: the page's reads keep real timers, so Testing Library's
// polling and the request timeout behave exactly as they do in the other page tests.
const REAL_TIMER_APIS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'nextTick',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'hrtime',
  'performance',
] as const

function stubReads(): void {
  readApiResultOrThrowMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/staff/team-members/self')) {
      return { member: { id: 'member-1', displayName: 'Tester' } }
    }
    if (url.includes('/api/staff/timesheets/my-projects')) {
      return { items: [{ time_project_id: 'project-1', show_in_grid: true }] }
    }
    if (url.includes('/api/staff/timesheets/time-projects')) {
      return { items: [{ id: 'project-1', name: 'Build', code: 'BLD', color: null }] }
    }
    return { items: [] }
  })
}

function formatDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function weekRange(date: Date): { from: string; to: string } {
  const monday = getMonday(date)
  return { from: formatDateKey(monday), to: formatDateKey(addDays(monday, 6)) }
}

function monthRange(date: Date): { from: string; to: string } {
  const year = date.getFullYear()
  const month = date.getMonth()
  return {
    from: formatDateKey(new Date(year, month, 1)),
    to: formatDateKey(new Date(year, month, getDaysInMonth(year, month))),
  }
}

function lastEntriesRange(): { from: string | null; to: string | null } {
  const entryCalls = readApiResultOrThrowMock.mock.calls.filter(([url]) =>
    String(url).includes('/api/staff/timesheets/time-entries'),
  )
  const lastUrl = String(entryCalls[entryCalls.length - 1]?.[0] ?? '')
  const params = new URLSearchParams(lastUrl.split('?')[1] ?? '')
  return { from: params.get('from'), to: params.get('to') }
}

function periodLabel(): string {
  const previous = screen.getByRole('button', { name: 'Previous period' })
  return previous.nextElementSibling?.textContent ?? ''
}

async function renderLoadedPage(): Promise<void> {
  render(<MyTimesheetsPage />)
  await waitFor(() => {
    expect(screen.getAllByRole('textbox', { name: /^Duration for Build on / }).length).toBeGreaterThan(0)
  })
}

describe('MyTimesheetsPage — date context across navigation and view switches', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ doNotFake: [...REAL_TIMER_APIS] })
    stubReads()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('names the icon-only period navigation buttons', async () => {
    jest.setSystemTime(new Date(2026, 8, 16, 10, 0))
    await renderLoadedPage()

    expect(screen.getByRole('button', { name: 'Previous period' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next period' })).toBeInTheDocument()
  })

  it('returns to the week the user navigated to after Weekly → Monthly → Weekly', async () => {
    const today = new Date(2026, 8, 16, 10, 0)
    jest.setSystemTime(today)
    await renderLoadedPage()
    expect(lastEntriesRange()).toEqual(weekRange(today))

    const twoWeeksBack = addDays(today, -14)
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(weekRange(twoWeeksBack)))
    const navigatedWeekLabel = periodLabel()

    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(monthRange(twoWeeksBack)))

    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(weekRange(twoWeeksBack)))
    expect(periodLabel()).toBe(navigatedWeekLabel)
  })

  it('clamps a 31st anchor into a shorter month and keeps that week when switching back to Weekly', async () => {
    const today = new Date(2026, 0, 31, 10, 0)
    jest.setSystemTime(today)
    await renderLoadedPage()

    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(monthRange(today)))

    const clampedAnchor = clampDateToMonth(today, 2026, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(monthRange(clampedAnchor)))

    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
    await waitFor(() => expect(lastEntriesRange()).toEqual(weekRange(clampedAnchor)))
  })
})
