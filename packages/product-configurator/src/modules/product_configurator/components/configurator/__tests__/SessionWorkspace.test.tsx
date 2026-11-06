/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { build } from '../../../lib/__tests__/fixtures'
import type { SessionDetail } from '../session/sessionApi'

Object.assign(globalThis, { TextEncoder })

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined

const apiCallMock = jest.fn()
const pushMock = jest.fn()
const flashMock = jest.fn()
const confirmMock = jest.fn()
const sessionMovedMock = jest.fn()
let guardRefusal: string | null = null
let grantedFeatures: string[] = ['product_configurator.sessions.manage', 'sales.quotes.view', 'sales.quotes.manage']

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => {
      if (guardRefusal) throw new Error(guardRefusal)
      return operation()
    },
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

jest.mock('@open-mercato/ui/backend/forms', () => ({
  FormHeader: ({ title, subtitle, actionsContent }: { title: React.ReactNode; subtitle?: string; actionsContent?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p data-testid="header-subtitle">{subtitle}</p>
      {actionsContent}
    </header>
  ),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

import { SessionWorkspace } from '../session/SessionWorkspace'
import type { ConfigurationDefinitionInput } from '../../../data/validators'

const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'

function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    selections: { motor: 'standard', length: 2, cover: false, color: 'red', seal: 'epdm', remote: false },
    visibility: { motor: true, length: true, cover: true, color: true, seal: true, remote: false },
    forced: [],
    availability: { motor: { allowedValues: ['standard', 'heavy'] }, color: { allowedValues: ['red', 'blue'] }, seal: { allowedValues: ['epdm', 'viton'] } },
    errors: [],
    warnings: [],
    surcharges: [],
    finalisable: true,
    bom: [{ bomId: 'base', sku: 'PUMP-BASE', label: 'Pump base', quantity: '1', uom: 'pcs', unitPrice: '1000', total: '1000.00' }],
    netPrice: '1000.00',
    currencyCode: 'EUR',
    hash: 'hash-1',
    ...overrides,
  }
}

function session(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: SESSION_ID,
    status: 'open',
    revision: 0,
    quoteId: QUOTE_ID,
    quote: { id: QUOTE_ID, number: 'SQ-42', customerName: 'Acme Farms', currencyCode: 'EUR' },
    modelVersion: { id: 'version-1', version: 3, modelTitle: 'Pump', definition: build() },
    selections: {},
    evaluation: null,
    ...overrides,
  }
}

function evaluated(revision: number, overrides: Record<string, unknown> = {}) {
  return { ok: true, status: 200, result: { id: SESSION_ID, status: 'open', revision, selections: {}, evaluation: evaluation(overrides) } }
}

function sessionRead(status: 'open' | 'finalising') {
  return { ok: true, status: 200, result: { ...session({ status, revision: 1 }), evaluation: evaluation() } }
}

function call(index: number) {
  const [url, init] = apiCallMock.mock.calls[index] as [string, { body: string }]
  return { url, body: JSON.parse(init.body) as Record<string, unknown> }
}

function lengthInput(): HTMLInputElement {
  const input = document.getElementById('configurator-feature-length')
  if (!(input instanceof HTMLInputElement)) throw new Error('[internal] length input missing')
  return input
}

function addButton(): HTMLButtonElement {
  const button = screen.getByTestId('configurator-add-to-quote')
  if (!(button instanceof HTMLButtonElement)) throw new Error('[internal] add button missing')
  return button
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function withDefinition(mutate: (input: ConfigurationDefinitionInput) => void): SessionDetail {
  return session({ modelVersion: { id: 'version-1', version: 3, modelTitle: 'Pump', definition: build(mutate) } })
}

async function renderReady(detail: SessionDetail = session()) {
  render(<SessionWorkspace session={detail} onSessionMoved={sessionMovedMock} />)
  await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,000.00'))
}

beforeEach(() => {
  apiCallMock.mockReset()
  pushMock.mockReset()
  flashMock.mockReset()
  confirmMock.mockReset()
  sessionMovedMock.mockReset()
  guardRefusal = null
  grantedFeatures = ['product_configurator.sessions.manage', 'sales.quotes.view', 'sales.quotes.manage']
  apiCallMock.mockResolvedValue(evaluated(1))
})

describe('SessionWorkspace', () => {
  it('evaluates on the session revision, shows the quote context and adds the result the rep saw', async () => {
    await renderReady()
    expect(call(0)).toEqual({ url: '/api/product_configurator/sessions/evaluate', body: { id: SESSION_ID, revision: 0, selections: {} } })
    expect(screen.getByTestId('header-subtitle').textContent).toBe('Quote SQ-42 · Acme Farms · Model v3')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Net price €1,000.00. 0 messages, 0 blocking.'))

    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { snapshotId: 'snap-1', quoteLineId: 'line-1', hash: 'hash-1', replay: false } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-add-to-quote'))
    })
    expect(call(1)).toEqual({ url: '/api/product_configurator/sessions/finalise', body: { id: SESSION_ID, expectedHash: 'hash-1', revision: 1 } })
    expect(flashMock).toHaveBeenCalledWith('Pump added to the quote (€1,000.00 net).', 'success')
    expect(pushMock).toHaveBeenCalledWith(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap-1`)
  })

  it('serializes evaluate calls so a quick second change carries the revision of the first answer', async () => {
    await renderReady()
    let resolveFirst: (value: unknown) => void = () => undefined
    apiCallMock.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    apiCallMock.mockResolvedValueOnce(evaluated(3, { netPrice: '1300.00' }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-seal-viton'))
    })
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveFirst(evaluated(2, { netPrice: '1250.00' }))
    })
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,300.00'))
    expect(call(2).body).toEqual({ id: SESSION_ID, revision: 2, selections: { motor: 'heavy', seal: 'viton' } })
  })

  it('shows a price change from finalise with the new BOM and adds it only after confirmation', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      result: { code: 'result_changed', result: evaluation({ netPrice: '1100.00', hash: 'hash-2' }) },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-add-to-quote'))
    })
    const panel = screen.getByTestId('configurator-finalise-outcome')
    expect(panel.textContent).toContain('The price changed from €1,000.00 to €1,100.00')
    expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,100.00')
    expect(pushMock).not.toHaveBeenCalled()

    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { snapshotId: 'snap-2', quoteLineId: 'line-2', hash: 'hash-2', replay: false } })
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Add with new price' }))
    })
    expect(call(2).body).toEqual({ id: SESSION_ID, expectedHash: 'hash-2', revision: 1 })
    expect(pushMock).toHaveBeenCalledWith(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap-2`)
  })

  it('lists the choices changed in another window and keeps the current state or re-applies the rep choices', async () => {
    await renderReady()
    const current = { id: SESSION_ID, status: 'open', revision: 5, selections: { motor: 'standard' }, evaluation: evaluation({ netPrice: '900.00' }) }
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 409, result: { code: 'session_changed', session: current } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    const panel = await screen.findByTestId('configurator-session-changed')
    expect(within(panel).getByText('Heavy duty 7 kW')).toBeTruthy()
    expect(within(panel).getByText('Standard 3 kW')).toBeTruthy()
    expect((screen.getByTestId('configurator-add-to-quote') as HTMLButtonElement).disabled).toBe(true)

    apiCallMock.mockResolvedValueOnce(evaluated(6, { netPrice: '1250.00' }))
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Apply my choices' }))
    })
    expect(call(2).body).toEqual({ id: SESSION_ID, revision: 5, selections: { motor: 'heavy' } })
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,250.00'))
    expect(screen.queryByTestId('configurator-session-changed')).toBeNull()
  })

  it('keeps the current state of a session changed in another window', async () => {
    await renderReady()
    const current = { id: SESSION_ID, status: 'open', revision: 5, selections: { motor: 'standard' }, evaluation: evaluation({ netPrice: '900.00' }) }
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 409, result: { code: 'session_changed', session: current } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('configurator-session-changed')).getByRole('button', { name: 'Keep current' }))
    })
    expect(screen.getByTestId('configurator-net-price').textContent).toBe('€900.00')
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    apiCallMock.mockResolvedValueOnce(evaluated(6))
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-seal-viton'))
    })
    expect(call(2).body).toEqual({ id: SESSION_ID, revision: 5, selections: { motor: 'standard', seal: 'viton' } })
  })

  it.each([
    [{ code: 'quote_converted' }, 'This quote was converted to an order or deleted', 'Go to quotes'],
    [{ code: 'model_deleted' }, 'its model was deleted', 'Discard configuration'],
    [{ code: 'finalise_in_progress' }, 'Another configuration is being added', 'Try again'],
    [{ code: 'finalise_busy' }, 'Adding is busy right now', 'Try again'],
    [{ code: 'session_not_open', status: 'cancelled' }, 'discarded in another window', 'Open the quote'],
  ])('explains finalise %j and offers its way out', async (body, text, action) => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 409, result: body })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-add-to-quote'))
    })
    const panel = screen.getByTestId('configurator-finalise-outcome')
    expect(panel.textContent).toContain(text)
    expect(within(panel).getByText(action)).toBeTruthy()
  })

  it('offers Try again after a failed line write and keeps the choices', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: { code: 'quote_line_write_failed', status: 'open' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-add-to-quote'))
    })
    expect(screen.getByTestId('configurator-finalise-outcome').textContent).toContain('Your choices are kept')
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { snapshotId: 'snap-3', quoteLineId: 'line-3', hash: 'hash-1', replay: true } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(call(2).body).toEqual({ id: SESSION_ID, expectedHash: 'hash-1', revision: 1 })
    expect(flashMock).toHaveBeenCalledWith(expect.stringContaining('already added to the quote in another window'), 'info')
  })

  it('stops editing after a line write with an unknown outcome so the page can reconcile it', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: { code: 'quote_line_write_failed', status: 'finalising' } })
    await act(async () => {
      fireEvent.click(addButton())
    })
    expect(sessionMovedMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('configurator-finalise-outcome')).toBeNull()
    expect(apiCallMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['open', 0],
    ['finalising', 1],
  ] as const)('reads the session after a failed line write without a status: %s', async (status, moved) => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: null })
    apiCallMock.mockResolvedValueOnce(sessionRead(status))
    await act(async () => {
      fireEvent.click(addButton())
    })
    expect(apiCallMock.mock.calls[2][0]).toBe(`/api/product_configurator/sessions?id=${SESSION_ID}`)
    expect(sessionMovedMock).toHaveBeenCalledTimes(moved)
    if (status === 'open') expect(within(screen.getByTestId('configurator-finalise-outcome')).getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows a configuration added with earlier choices as finished: read-only, no Discard, a link to the added line', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      result: { snapshotId: 'snap-old', quoteLineId: 'line-old', hash: 'hash-0', replay: false, outcome: 'added_with_earlier_choices' },
    })
    await act(async () => {
      fireEvent.click(addButton())
    })
    const panel = screen.getByTestId('configurator-finalise-outcome')
    expect(panel.getAttribute('data-outcome')).toBe('added_with_earlier_choices')
    expect(panel.textContent).toContain('already added to the quote with an earlier result. Your later changes were not added.')
    expect(within(panel).getByText('Open the quote').getAttribute('href')).toBe(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap-old`)
    expect(screen.queryByRole('button', { name: 'Discard configuration' })).toBeNull()
    expect(addButton().disabled).toBe(true)
    expect(lengthInput().closest('fieldset')?.disabled).toBe(true)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('moves focus to an outcome when it appears, not on every render', async () => {
    const detail = session()
    apiCallMock.mockResolvedValue({ ok: false, status: 409, result: { code: 'session_not_open', status: 'finalised' } })
    const view = render(<SessionWorkspace session={detail} onSessionMoved={sessionMovedMock} />)
    const panel = await screen.findByTestId('configurator-finalise-outcome')
    expect(document.activeElement).toBe(panel)
    const link = within(panel).getByText('Open the quote')
    link.focus()
    view.rerender(<SessionWorkspace session={detail} onSessionMoved={sessionMovedMock} />)
    expect(document.activeElement).toBe(link)
  })

  it('shows a deterministic evaluate error without Retry and disables Add to quote', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 422, result: { code: 'price_missing', params: { skus: ['PUMP-BASE'], channelId: null } } })
    render(<SessionWorkspace session={session()} onSessionMoved={sessionMovedMock} />)
    await waitFor(() => expect(screen.getByTestId('configurator-failure').textContent).toContain('No catalog price for PUMP-BASE'))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect((screen.getByTestId('configurator-add-to-quote') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps showing the rep choice after an evaluation the model cannot compute', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 422, result: { code: 'expression_error', params: { formulaKey: 'pipe_meters' } } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    await waitFor(() => expect(screen.getByTestId('configurator-failure').textContent).toContain('This model needs a fix by an admin'))
    expect(screen.getByTestId('configurator-option-motor-heavy').getAttribute('aria-checked')).toBe('true')
  })

  it('tells a rep without quote edit rights who can finish the configuration', async () => {
    grantedFeatures = ['product_configurator.sessions.manage', 'sales.quotes.view']
    await renderReady()
    expect(screen.getByTestId('configurator-no-edit-rights').textContent).toContain('Someone who can edit this quote can finish it')
    expect((screen.getByTestId('configurator-add-to-quote') as HTMLButtonElement).disabled).toBe(true)
  })

  it('discards after confirmation and returns to the quote', async () => {
    await renderReady()
    confirmMock.mockResolvedValueOnce(true)
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { status: 'cancelled' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard configuration' }))
    })
    expect(call(1)).toEqual({ url: '/api/product_configurator/sessions/cancel', body: { id: SESSION_ID } })
    expect(pushMock).toHaveBeenCalledWith(`/backend/sales/quotes/${QUOTE_ID}`)
  })

  it('shows the stored result of a resumed session while it is re-evaluated', async () => {
    let resolve: (value: unknown) => void = () => undefined
    apiCallMock.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    render(
      <SessionWorkspace
        session={session({ revision: 4, selections: { motor: 'heavy' }, evaluation: evaluation({ netPrice: '1250.00' }) })}
        onSessionMoved={sessionMovedMock}
      />,
    )
    expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,250.00')
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1))
    expect(call(0).body).toEqual({ id: SESSION_ID, revision: 4, selections: { motor: 'heavy' } })
    await act(async () => {
      resolve(evaluated(5, { netPrice: '1260.00' }))
    })
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,260.00'))
  })

  describe('readiness of every add action', () => {
    async function failWrite() {
      apiCallMock.mockResolvedValueOnce({ ok: false, status: 502, result: { code: 'quote_line_write_failed', status: 'open' } })
      await act(async () => {
        fireEvent.click(addButton())
      })
      const panel = screen.getByTestId('configurator-finalise-outcome')
      return within(panel).getByRole('button', { name: 'Try again' }) as HTMLButtonElement
    }

    it('disables Try again while a field holds an invalid number', async () => {
      await renderReady()
      const tryAgain = await failWrite()
      expect(tryAgain.disabled).toBe(false)
      fireEvent.change(lengthInput(), { target: { value: '0.7' } })
      expect(tryAgain.disabled).toBe(true)
      expect(addButton().disabled).toBe(true)
      fireEvent.click(tryAgain)
      expect(apiCallMock).toHaveBeenCalledTimes(2)
    })

    it('disables Try again while the edited choices are being evaluated, then adds the new result', async () => {
      await renderReady()
      const tryAgain = await failWrite()
      const pending = deferred<unknown>()
      apiCallMock.mockImplementationOnce(() => pending.promise)
      await act(async () => {
        fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
      })
      expect(tryAgain.disabled).toBe(true)
      await act(async () => {
        pending.resolve(evaluated(2, { hash: 'hash-heavy' }))
      })
      await waitFor(() => expect(tryAgain.disabled).toBe(false))
      apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { snapshotId: 'snap-4', quoteLineId: 'line-4', hash: 'hash-heavy', replay: false } })
      await act(async () => {
        fireEvent.click(tryAgain)
      })
      expect(call(3).body).toEqual({ id: SESSION_ID, expectedHash: 'hash-heavy', revision: 2 })
    })
  })

  describe('invalid number text', () => {
    it('stops blocking Add once a rule hides the field', async () => {
      const detail = withDefinition((input) => {
        const length = input.features.find((feature) => feature.key === 'length')
        if (length) length.visibleWhen = [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'standard' }]
      })
      await renderReady(detail)
      fireEvent.change(lengthInput(), { target: { value: 'abc' } })
      expect(addButton().disabled).toBe(true)
      apiCallMock.mockResolvedValueOnce(evaluated(2, { visibility: { motor: true, length: false, cover: true, color: true, seal: true, remote: true } }))
      await act(async () => {
        fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
      })
      await waitFor(() => expect(document.getElementById('configurator-feature-length')).toBeNull())
      expect(addButton().disabled).toBe(false)
    })

    it('stops blocking Add once a rule sets the value', async () => {
      await renderReady()
      fireEvent.change(lengthInput(), { target: { value: 'abc' } })
      expect(addButton().disabled).toBe(true)
      apiCallMock.mockResolvedValueOnce(
        evaluated(2, {
          selections: { motor: 'standard', length: 5, cover: false, color: 'red', seal: 'viton', remote: false },
          forced: [{ featureKey: 'length', ruleId: 'viton-length', from: 2, to: 5 }],
        }),
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('configurator-option-seal-viton'))
      })
      await waitFor(() => expect(lengthInput().disabled).toBe(true))
      expect(lengthInput().value).toBe('5')
      expect(lengthInput().getAttribute('aria-invalid')).toBeNull()
      expect(addButton().disabled).toBe(false)
    })

    it('stops blocking Add once Keep current replaces the value', async () => {
      await renderReady()
      fireEvent.change(lengthInput(), { target: { value: 'abc' } })
      const current = { id: SESSION_ID, status: 'open', revision: 5, selections: { length: 4 }, evaluation: evaluation({ selections: { motor: 'standard', length: 4, cover: false, color: 'red', seal: 'epdm', remote: false } }) }
      apiCallMock.mockResolvedValueOnce({ ok: false, status: 409, result: { code: 'session_changed', session: current } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
      })
      await act(async () => {
        fireEvent.click(within(await screen.findByTestId('configurator-session-changed')).getByRole('button', { name: 'Keep current' }))
      })
      expect(lengthInput().value).toBe('4')
      expect(addButton().disabled).toBe(false)
    })

    async function keepCurrentLength(length: number) {
      const selections = { motor: 'standard', length, cover: false, color: 'red', seal: 'epdm', remote: false }
      const current = { id: SESSION_ID, status: 'open', revision: 5, selections: { length }, evaluation: evaluation({ selections }) }
      apiCallMock.mockResolvedValueOnce({ ok: false, status: 409, result: { code: 'session_changed', session: current } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
      })
      await act(async () => {
        fireEvent.click(within(await screen.findByTestId('configurator-session-changed')).getByRole('button', { name: 'Keep current' }))
      })
    }

    it('drops invalid text when Keep current keeps the same value', async () => {
      await renderReady()
      fireEvent.change(lengthInput(), { target: { value: 'abc' } })
      expect(addButton().disabled).toBe(true)
      await keepCurrentLength(2)
      expect(lengthInput().value).toBe('2')
      expect(lengthInput().getAttribute('aria-invalid')).toBeNull()
      expect(screen.queryByTestId('configurator-invalid-field')).toBeNull()
      expect(addButton().disabled).toBe(false)
    })

    it('drops a pending commit of typed text when Keep current resets the choices', async () => {
      await renderReady()
      fireEvent.change(lengthInput(), { target: { value: '3' } })
      await keepCurrentLength(2)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      expect(apiCallMock).toHaveBeenCalledTimes(2)
      expect(lengthInput().value).toBe('2')
    })
  })

  it('names an invalid number hidden in a collapsed group and opens the group on request', async () => {
    const detail = withDefinition((input) => {
      for (const feature of input.features) feature.group = feature.key === 'length' ? 'Pipe' : 'Pump'
    })
    await renderReady(detail)
    fireEvent.change(lengthInput(), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pipe' }))
    expect(addButton().disabled).toBe(true)
    const hint = screen.getByTestId('configurator-invalid-field')
    expect(hint.textContent).toContain('Fix the value of Pipe length to continue.')
    await act(async () => {
      fireEvent.click(within(hint).getByRole('button', { name: 'Show the field' }))
    })
    expect(screen.getByRole('button', { name: 'Pipe' }).getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(lengthInput())
  })

  it('opens a collapsed group before moving focus to the field a message points to', async () => {
    const detail = withDefinition((input) => {
      for (const feature of input.features) feature.group = feature.key === 'length' ? 'Pipe' : 'Pump'
      input.rules.push({
        id: 'long-pipe',
        effect: 'warning',
        when: [{ kind: 'compare', featureKey: 'length', op: 'eq', value: 2 }],
        messageTemplate: 'Check the pipe length.',
        featureKeys: ['length'],
        order: 1,
      })
    })
    apiCallMock.mockResolvedValue(evaluated(1, { warnings: [{ ruleId: 'long-pipe', params: {} }] }))
    await renderReady(detail)
    fireEvent.click(screen.getByRole('button', { name: 'Pipe' }))
    expect(screen.getByRole('button', { name: 'Pipe' }).getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go to Pipe length' }))
    })
    expect(screen.getByRole('button', { name: 'Pipe' }).getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(lengthInput())
  })

  it('links a server field error to its control', async () => {
    await renderReady()
    apiCallMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      result: { code: 'invalid_selection', issues: [{ featureKey: 'motor', reason: 'not_an_option', value: 'heavy' }] },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    const group = await screen.findByRole('radiogroup', { name: 'Motor' })
    expect(group.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(group.getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toBe('This option no longer exists. Choose another one.')
  })

  it('keeps an unavailable select option reachable with its reason, without selecting it', async () => {
    const detail = withDefinition((input) => {
      input.features.push({
        key: 'size',
        label: 'Size',
        type: 'choice',
        options: ['xs', 's', 'm', 'l', 'xl', 'xxl'].map((value, index) => ({ value, label: value.toUpperCase(), order: index + 1 })),
        default: 'm',
        order: 7,
        inSummary: false,
      })
    })
    apiCallMock.mockResolvedValue(
      evaluated(1, {
        selections: { motor: 'standard', length: 2, cover: false, color: 'red', seal: 'epdm', remote: false, size: 'm' },
        availability: { size: { allowedValues: ['xs', 's', 'm', 'l', 'xl'] } },
      }),
    )
    await renderReady(detail)
    const trigger = screen.getByRole('combobox', { name: 'Size' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(trigger)
    const blocked = await screen.findByRole('option', { name: 'XXL (Not available with the current choices.)' })
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(blocked.hasAttribute('data-disabled')).toBe(false)
    const calls = apiCallMock.mock.calls.length
    fireEvent.pointerDown(blocked)
    fireEvent.click(blocked)
    expect(apiCallMock.mock.calls.length).toBe(calls)
  })

  it('shows the text of a mutation guard that refused the add, not a network error', async () => {
    await renderReady()
    guardRefusal = 'This quote is locked by Anna K.'
    await act(async () => {
      fireEvent.click(addButton())
    })
    const panel = screen.getByTestId('configurator-finalise-outcome')
    expect(panel.textContent).toContain('This quote is locked by Anna K.')
    expect(panel.textContent).not.toContain('Could not reach the server')
  })
})
