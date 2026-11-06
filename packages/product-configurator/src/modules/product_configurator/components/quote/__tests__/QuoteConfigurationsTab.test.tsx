/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

Object.assign(globalThis, { TextEncoder })
Element.prototype.scrollIntoView = jest.fn()

const apiCallMock = jest.fn()
const pushMock = jest.fn()
const flashMock = jest.fn()
const confirmMock = jest.fn()
type RunMutationInput = { operation: () => Promise<unknown>; context: Record<string, unknown> }
const runMutationMock = jest.fn(async ({ operation }: RunMutationInput) => operation())
let searchParams = new URLSearchParams()
let grantedFeatures: string[] = []

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: (input: RunMutationInput) => runMutationMock(input),
    retryLastMutation: async () => false,
  }),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: (...args: unknown[]) => confirmMock(...args), ConfirmDialogElement: null }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures }, isReady: true }),
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <p>{label}</p>,
  ErrorMessage: ({ label, action }: { label: string; action?: React.ReactNode }) => (
    <div data-testid="error-message">
      {label}
      {action}
    </div>
  ),
  TabEmptyState: ({ title }: { title: string }) => <p data-testid="empty-state">{title}</p>,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }), useSearchParams: () => searchParams }))

import { QuoteConfigurationsTab } from '../QuoteConfigurationsTab'

const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const ALL_FEATURES = ['product_configurator.sessions.manage', 'product_configurator.models.view', 'product_configurator.snapshots.view', 'sales.quotes.view']

function snapshot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: `session-${id}`,
    quoteId: QUOTE_ID,
    quoteLineId: `line-${id}`,
    lineState: 'present',
    lineName: 'Pump (farm spec)',
    modelTitle: 'Pump',
    modelVersion: { id: 'v1', version: 3, hash: 'h' },
    summary: 'Motor: Heavy duty 7 kW',
    selectionRows: [],
    calculatedRows: [],
    specification: [],
    bom: [],
    netPrice: '1250.00',
    currencyCode: 'EUR',
    warnings: [],
    hash: 'h',
    createdAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  }
}

function model(id: string, title: string) {
  return { id, title, latestVersion: { id: `${id}-v`, version: 2, hash: 'h', publishedAt: '2026-11-01T00:00:00.000Z' } }
}

function sessionItem(id: string) {
  return {
    id,
    status: 'open',
    mode: 'new',
    revision: 2,
    quoteId: QUOTE_ID,
    modelVersion: { id: 'v', version: 4, hash: 'h', modelId: 'm1', modelTitle: 'Pump' },
    createdBy: { id: 'u1', displayName: 'Anna K.' },
    createdAt: '2026-11-06T10:00:00.000Z',
  }
}

function respond(routes: { snapshots?: unknown; sessions?: unknown; models?: unknown; open?: unknown; cancel?: unknown }) {
  apiCallMock.mockImplementation((url: string, init?: { method?: string }) => {
    const ok = (result: unknown, status = 200) => Promise.resolve({ ok: status < 300, status, result })
    if (url.startsWith('/api/product_configurator/snapshots')) return ok(routes.snapshots ?? { items: [] })
    if (url.startsWith('/api/product_configurator/models')) return ok(routes.models ?? { items: [] })
    if (url === '/api/product_configurator/sessions/cancel') return ok(routes.cancel ?? { status: 'cancelled' })
    if (url === '/api/product_configurator/sessions' && init?.method === 'POST') {
      return (routes.open as Promise<unknown> | undefined) ?? ok({ sessionId: 'new-session' }, 201)
    }
    if (url.startsWith('/api/product_configurator/sessions')) return ok(routes.sessions ?? { items: [] })
    return ok(null, 404)
  })
}

beforeEach(() => {
  apiCallMock.mockReset()
  pushMock.mockReset()
  flashMock.mockReset()
  confirmMock.mockReset()
  runMutationMock.mockReset()
  runMutationMock.mockImplementation(async ({ operation }: RunMutationInput) => operation())
  searchParams = new URLSearchParams()
  grantedFeatures = ALL_FEATURES
})

describe('QuoteConfigurationsTab', () => {
  it('lists configured lines with their state and links, and loads only models of the quote currency', async () => {
    respond({
      snapshots: { items: [snapshot('a'), snapshot('b', { lineState: 'removed', lineName: null, modelTitle: 'Pump old' })] },
      models: { items: [model('m1', 'Pump')] },
    })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const present = await screen.findByTestId('quote-configured-line-a')
    expect(present.textContent).toContain('Pump (farm spec)')
    expect(present.textContent).toContain('On quote')
    expect(present.textContent).toContain('€1,250.00')
    expect(within(present).getByText('Configuration details').getAttribute('href')).toBe(`/backend/product_configurator/snapshots/a?quoteId=${QUOTE_ID}`)
    const removed = screen.getByTestId('quote-configured-line-b')
    expect(removed.textContent).toContain('Pump old')
    expect(removed.textContent).toContain('Line removed')
    const modelsUrl = apiCallMock.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith('/api/product_configurator/models')) ?? ''
    expect(modelsUrl).toContain('published=true')
    expect(modelsUrl).toContain('currencyCode=EUR')
  })

  it('opens the only fitting model straight away', async () => {
    respond({ models: { items: [model('m1', 'Pump')] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const configure = await screen.findByTestId('quote-configure-product')
    await act(async () => {
      fireEvent.click(configure)
    })
    const post = apiCallMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ quoteId: QUOTE_ID, modelId: 'm1' })
    expect(pushMock).toHaveBeenCalledWith('/backend/product_configurator/configure/new-session')
  })

  it('asks for a model when several fit', async () => {
    respond({ models: { items: [model('m1', 'Pump'), model('m2', 'Pump compact')] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const configure = await screen.findByTestId('quote-configure-product')
    await act(async () => {
      fireEvent.click(configure)
    })
    const picker = await screen.findByTestId('quote-configure-model-picker')
    fireEvent.click(within(picker).getByRole('radio', { name: /Pump compact/ }))
    await act(async () => {
      fireEvent.keyDown(picker, { key: 'Enter', ctrlKey: true })
    })
    const post = apiCallMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ quoteId: QUOTE_ID, modelId: 'm2' })
  })

  it('says when no model fits the quote currency, before anything is clicked', async () => {
    respond({ models: { items: [] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="PLN" />)
    expect((await screen.findByTestId('quote-configure-nothing-fits')).textContent).toContain('No published model uses PLN')
    expect(screen.queryByTestId('quote-configure-product')).toBeNull()
    const link = screen.getByText('Open models')
    expect(link.getAttribute('href')).toBe('/backend/product_configurator/models')
    expect(link.parentElement?.textContent).toBe('Admins can publish one: Open models')
    expect(screen.queryByTestId('empty-state')).toBeNull()
  })

  it('reloads the models when the chosen one is no longer offered', async () => {
    respond({
      models: { items: [model('m1', 'Pump')] },
      open: Promise.resolve({ ok: false, status: 409, result: { code: 'no_published_version' } }),
    })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const configure = await screen.findByTestId('quote-configure-product')
    await act(async () => {
      fireEvent.click(configure)
    })
    expect(await screen.findByText(/no longer offered for this quote/)).toBeTruthy()
    await waitFor(() =>
      expect(apiCallMock.mock.calls.filter(([url]) => String(url).startsWith('/api/product_configurator/models')).length).toBe(2),
    )
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('lists configurations in progress with who started them, and discards one after confirmation', async () => {
    respond({
      sessions: {
        items: [
          {
            id: 's1',
            status: 'open',
            mode: 'new',
            revision: 2,
            quoteId: QUOTE_ID,
            modelVersion: { id: 'v', version: 4, hash: 'h', modelId: 'm1', modelTitle: 'Pump' },
            createdBy: { id: 'u1', displayName: 'Anna K.' },
            createdAt: '2026-11-06T10:00:00.000Z',
          },
        ],
      },
      models: { items: [model('m1', 'Pump')] },
    })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const row = await screen.findByTestId('quote-session-s1')
    expect(row.textContent).toContain('Started by Anna K.')
    expect(within(row).getByText('Continue').getAttribute('href')).toBe('/backend/product_configurator/configure/s1')
    confirmMock.mockResolvedValueOnce(true)
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Discard' }))
    })
    const cancel = apiCallMock.mock.calls.find(([url]) => url === '/api/product_configurator/sessions/cancel')
    expect(JSON.parse((cancel?.[1] as { body: string }).body)).toEqual({ id: 's1' })
    expect(runMutationMock.mock.calls[0][0].context).toMatchObject({ resourceKind: 'product_configurator.session', resourceId: 's1' })
    expect(flashMock).toHaveBeenCalledWith(expect.stringContaining('Configuration discarded'), 'success')
  })

  it('lists configurations in progress to a user who can manage sessions but not view models, without Configure', async () => {
    grantedFeatures = ['product_configurator.sessions.manage', 'product_configurator.snapshots.view', 'sales.quotes.view']
    respond({ sessions: { items: [sessionItem('s1')] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const row = await screen.findByTestId('quote-session-s1')
    expect(within(row).getByText('Continue').getAttribute('href')).toBe('/backend/product_configurator/configure/s1')
    expect(within(row).getByRole('button', { name: 'Discard' })).toBeTruthy()
    expect(screen.queryByTestId('quote-configure-product')).toBeNull()
    expect(screen.queryByTestId('quote-configure-nothing-fits')).toBeNull()
    expect(apiCallMock.mock.calls.some(([url]) => String(url).startsWith('/api/product_configurator/models'))).toBe(false)
  })

  it('shows the text of a mutation guard that refused the discard, not a network error', async () => {
    respond({ sessions: { items: [sessionItem('s1')] }, models: { items: [model('m1', 'Pump')] } })
    runMutationMock.mockRejectedValueOnce(new Error('This quote is locked by Anna K.'))
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const row = await screen.findByTestId('quote-session-s1')
    confirmMock.mockResolvedValueOnce(true)
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Discard' }))
    })
    expect(apiCallMock.mock.calls.some(([url]) => url === '/api/product_configurator/sessions/cancel')).toBe(false)
    expect(flashMock).toHaveBeenCalledWith('This quote is locked by Anna K.', 'error')
  })

  it('highlights and focuses the line just added', async () => {
    searchParams = new URLSearchParams({ configuredLine: 'a' })
    respond({ snapshots: { items: [snapshot('a')] }, models: { items: [model('m1', 'Pump')] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    const line = await screen.findByTestId('quote-configured-line-a')
    expect(line.getAttribute('data-highlighted')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(line))
  })

  it('shows only the configured lines to a user who cannot configure', async () => {
    grantedFeatures = ['product_configurator.snapshots.view', 'sales.quotes.view']
    respond({ snapshots: { items: [snapshot('a')] } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    await screen.findByTestId('quote-configured-line-a')
    expect(screen.queryByTestId('quote-configure-product')).toBeNull()
    expect(apiCallMock.mock.calls.map(([url]) => String(url)).every((url) => url.startsWith('/api/product_configurator/snapshots'))).toBe(true)
  })

  it('says when the quote has more configurations than the list shows', async () => {
    respond({ snapshots: { items: [snapshot('a'), snapshot('b')], truncated: true } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    await screen.findByTestId('quote-configured-line-a')
    expect(screen.getByTestId('quote-configurations-truncated').textContent).toContain('Only the oldest 2 are listed here')
  })

  it('shows no truncation notice when every configuration is listed', async () => {
    respond({ snapshots: { items: [snapshot('a')], truncated: false } })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    await screen.findByTestId('quote-configured-line-a')
    expect(screen.queryByTestId('quote-configurations-truncated')).toBeNull()
  })

  it('shows an error, not an empty list, when a list fails to load', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 500, result: null })
    render(<QuoteConfigurationsTab quoteId={QUOTE_ID} currencyCode="EUR" />)
    expect((await screen.findByTestId('error-message')).textContent).toContain('Could not load the configurations')
    expect(screen.queryByTestId('empty-state')).toBeNull()
  })
})
