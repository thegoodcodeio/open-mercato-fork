/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { build } from '../../../lib/__tests__/fixtures'

Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()
const pushMock = jest.fn()
const flashMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string | Record<string, string | number>, params?: Record<string, string | number>) =>
    typeof fallback === 'object'
      ? key
      : (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({ useOrganizationScopeVersion: () => 0 }))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
    retryLastMutation: async () => false,
  }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <p data-testid="loading">{label}</p>,
  ErrorMessage: ({ label }: { label: string }) => <p>{label}</p>,
  RecordNotFoundState: ({ label }: { label: string }) => <p>{label}</p>,
}))

jest.mock('@open-mercato/ui/backend/forms', () => ({
  FormHeader: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures: ['sales.quotes.manage'] }, isReady: true }),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => false, ConfirmDialogElement: null }),
}))

import { SessionConfigurator } from '../session/SessionConfigurator'

const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'

function evaluation() {
  return {
    selections: { motor: 'standard' },
    visibility: {},
    forced: [],
    availability: {},
    errors: [],
    warnings: [],
    surcharges: [],
    finalisable: true,
    bom: [],
    netPrice: '1000.00',
    currencyCode: 'EUR',
    hash: 'hash-1',
  }
}

function sessionBody(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    status: 'finalising',
    revision: 3,
    quoteId: QUOTE_ID,
    quote: { id: QUOTE_ID, number: 'SQ-42', customerName: 'Acme Farms', currencyCode: 'EUR' },
    modelVersion: { id: 'version-1', version: 3, modelTitle: 'Pump', definition: build() },
    selections: { motor: 'standard' },
    evaluation: evaluation(),
    ...overrides,
  }
}

function sessionReads(): number {
  return apiCallMock.mock.calls.filter(([url]) => String(url).startsWith('/api/product_configurator/sessions?id=')).length
}

beforeEach(() => {
  apiCallMock.mockReset()
  pushMock.mockReset()
  flashMock.mockReset()
})

describe('SessionConfigurator', () => {
  it('says a finalised configuration was added even when its quote was converted later', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: sessionBody({ status: 'finalised', quote: null }) })
    render(<SessionConfigurator sessionId={SESSION_ID} />)
    const closed = await screen.findByTestId('configurator-session-closed')
    expect(closed.textContent).toContain('This configuration was added to the quote.')
    expect(closed.textContent).not.toContain('Nothing was added')
    expect(within(closed).getByText('Go to quotes').getAttribute('href')).toBe('/backend/sales/quotes')
  })

  it('reloads a finalising session when the server answers that it moved on', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody() })
    render(<SessionConfigurator sessionId={SESSION_ID} />)
    const finalising = await screen.findByTestId('configurator-session-finalising')
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: { code: 'quote_line_write_failed' } })
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody({ status: 'cancelled' }) })
    await act(async () => {
      fireEvent.click(within(finalising).getByRole('button', { name: 'Add to quote' }))
    })
    expect(flashMock).toHaveBeenCalledWith('The line could not be added to the quote. Your choices are kept.', 'error')
    expect(sessionReads()).toBe(2)
    expect((await screen.findByTestId('configurator-session-closed')).textContent).toContain('This configuration was discarded')
  })

  it('locks editing after a line write with an unknown outcome and recovers it without another line', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody({ status: 'open', evaluation: null }) })
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { id: SESSION_ID, status: 'open', revision: 4, selections: {}, evaluation: evaluation() } })
    render(<SessionConfigurator sessionId={SESSION_ID} />)
    const add = await screen.findByTestId('configurator-add-to-quote')
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))

    apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: { code: 'quote_line_write_failed', status: 'finalising' } })
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody({ revision: 4 }) })
    await act(async () => {
      fireEvent.click(add)
    })
    const finalising = await screen.findByTestId('configurator-session-finalising')
    expect(screen.queryByTestId('configurator-workspace')).toBeNull()
    expect(sessionReads()).toBe(2)

    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { snapshotId: 'snap-1', quoteLineId: 'line-1', hash: 'hash-1', replay: true, outcome: 'added' } })
    await act(async () => {
      fireEvent.click(within(finalising).getByRole('button', { name: 'Add to quote' }))
    })
    const finaliseCalls = apiCallMock.mock.calls.filter(([url]) => url === '/api/product_configurator/sessions/finalise')
    expect(finaliseCalls.map(([, init]) => JSON.parse((init as { body: string }).body))).toEqual([
      { id: SESSION_ID, expectedHash: 'hash-1', revision: 4 },
      { id: SESSION_ID, expectedHash: 'hash-1', revision: 4 },
    ])
    expect(pushMock).toHaveBeenCalledWith(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap-1`)
  })

  it('opens the line added with earlier choices when a finalising session is completed', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody() })
    render(<SessionConfigurator sessionId={SESSION_ID} />)
    const finalising = await screen.findByTestId('configurator-session-finalising')
    apiCallMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      result: { snapshotId: 'snap-0', quoteLineId: 'line-0', hash: 'hash-0', replay: false, outcome: 'added_with_earlier_choices' },
    })
    await act(async () => {
      fireEvent.click(within(finalising).getByRole('button', { name: 'Add to quote' }))
    })
    expect(flashMock).toHaveBeenCalledWith(expect.stringContaining('with an earlier result'), 'warning')
    expect(pushMock).toHaveBeenCalledWith(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap-0`)
  })

  it.each([
    [{ ok: false, status: 409, result: { code: 'finalise_in_progress' } }, 'Another configuration is being added'],
    [{ ok: false, status: 409, result: { code: 'finalise_busy' } }, 'Adding is busy right now'],
    [{ ok: false, status: 503, result: null }, 'Could not reach the server'],
  ])('keeps a finalising session and explains %j', async (response, text) => {
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: sessionBody() })
    render(<SessionConfigurator sessionId={SESSION_ID} />)
    const finalising = await screen.findByTestId('configurator-session-finalising')
    apiCallMock.mockResolvedValueOnce(response)
    await act(async () => {
      fireEvent.click(within(finalising).getByRole('button', { name: 'Add to quote' }))
    })
    expect(screen.getByTestId('configurator-finalise-outcome').textContent).toContain(text)
    expect(sessionReads()).toBe(1)
  })
})
