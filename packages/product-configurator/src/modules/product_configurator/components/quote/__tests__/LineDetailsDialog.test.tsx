/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'

Object.assign(globalThis, { TextEncoder })
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined

const apiCallMock = jest.fn()
const apiCallOrThrowMock = jest.fn()
const scopedHeaders: Array<Record<string, string>> = []
const flashMock = jest.fn()
const conflictMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  apiCallOrThrow: (...args: unknown[]) => apiCallOrThrowMock(...args),
  withScopedApiRequestHeaders: async (headers: Record<string, string>, run: () => Promise<unknown>) => {
    scopedHeaders.push(headers)
    return run()
  },
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
    retryLastMutation: async () => false,
  }),
}))

jest.mock('@open-mercato/ui/backend/conflicts', () => ({
  surfaceRecordConflict: (...args: unknown[]) => conflictMock(...args),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <p>{label}</p>,
  ErrorMessage: ({ label }: { label: string }) => <p data-testid="error-message">{label}</p>,
}))

import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { ForbiddenError } from '@open-mercato/ui/backend/utils/api'
import { LineDetailsDialog } from '../LineDetailsDialog'

const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const LINE_ID = '44444444-4444-4444-8444-444444444444'

function respond(options: { taxStatus?: number | 'forbidden'; line?: Record<string, unknown> } = {}) {
  apiCallMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/sales/quote-lines')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        result: {
          items: [
            {
              id: LINE_ID,
              name: 'Pump (farm spec)',
              comment: 'Deliver after harvest',
              quantity: '1.0000',
              quantity_unit: 'pc',
              currency_code: 'EUR',
              unit_price_net: '1250.0000',
              discount_percent: '5.0000',
              discount_amount: '0',
              tax_rate: '23.0000',
              ...options.line,
            },
          ],
        },
      })
    }
    const taxStatus = options.taxStatus ?? 200
    if (taxStatus === 'forbidden') return Promise.reject(new ForbiddenError('Forbidden', { requiredFeatures: ['sales.settings.manage'] }))
    return Promise.resolve({
      ok: taxStatus === 200,
      status: taxStatus,
      result: taxStatus === 200 ? { items: [{ id: 'vat-23', name: 'VAT', rate: '23' }] } : { error: 'Failed' },
    })
  })
}

function renderDialog(props: Partial<React.ComponentProps<typeof LineDetailsDialog>> = {}) {
  const handlers = { onClose: jest.fn(), onSaved: jest.fn(), onConflict: jest.fn() }
  render(
    <LineDetailsDialog
      quoteId={QUOTE_ID}
      lineId={LINE_ID}
      currencyCode="EUR"
      canReadTaxRates
      lockToken="2026-11-06T10:00:00.000Z"
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

beforeEach(() => {
  apiCallMock.mockReset()
  apiCallOrThrowMock.mockReset()
  flashMock.mockReset()
  conflictMock.mockReset()
  scopedHeaders.length = 0
})

describe('LineDetailsDialog', () => {
  it('prefills the line, shows quantity and price read-only and saves only the changes with the quote lock', async () => {
    respond()
    const handlers = renderDialog()
    const name = await screen.findByDisplayValue('Pump (farm spec)')
    expect(screen.getByDisplayValue('5')).toBeTruthy()
    const readOnly = screen.getByTestId('line-details-read-only')
    expect(readOnly.textContent).toContain('1 pc')
    expect(readOnly.textContent).toContain('€1,250.00')
    expect(readOnly.querySelector('input')).toBeNull()
    expect(screen.getByTestId('line-details-save').hasAttribute('disabled')).toBe(true)

    fireEvent.change(name, { target: { value: 'Pump (renamed)' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Amount (EUR)' }))
    fireEvent.change(screen.getByLabelText('Discount amount (EUR)'), { target: { value: '100,50' } })
    apiCallOrThrowMock.mockResolvedValueOnce({ ok: true, status: 200, result: { lineId: LINE_ID, updatedAt: '2026-11-06T11:00:00.000Z' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('line-details-dialog'), { key: 'Enter', ctrlKey: true })
    })

    const [url, init] = apiCallOrThrowMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('/api/product_configurator/lines/update')
    expect(JSON.parse(init.body)).toEqual({ quoteId: QUOTE_ID, lineId: LINE_ID, name: 'Pump (renamed)', discount: { mode: 'amount', value: 100.5 } })
    expect(scopedHeaders[0]).toEqual({ [OPTIMISTIC_LOCK_HEADER_NAME]: '2026-11-06T10:00:00.000Z' })
    expect(handlers.onSaved).toHaveBeenCalledWith('2026-11-06T11:00:00.000Z')
  })

  it('switches the discount off with None', async () => {
    respond()
    renderDialog()
    await screen.findByDisplayValue('Pump (farm spec)')
    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    apiCallOrThrowMock.mockResolvedValueOnce({ ok: true, status: 200, result: { lineId: LINE_ID, updatedAt: null } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('line-details-save'))
    })
    expect(JSON.parse((apiCallOrThrowMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      quoteId: QUOTE_ID,
      lineId: LINE_ID,
      discount: { mode: 'none' },
    })
  })

  it('does not read tax rates without the sales settings feature and keeps the current tax', async () => {
    respond()
    renderDialog({ canReadTaxRates: false })
    await screen.findByDisplayValue('Pump (farm spec)')
    expect(apiCallMock.mock.calls.map(([url]) => url)).not.toContain('/api/sales/tax-rates?pageSize=100')
    expect(screen.getByText('You cannot read the tax rates, so the current tax is kept.')).toBeTruthy()
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  })

  it('opens and keeps the current tax when the tax rates answer 403 (apiCall throws ForbiddenError)', async () => {
    respond({ taxStatus: 'forbidden' })
    renderDialog()
    await screen.findByDisplayValue('Pump (farm spec)')
    expect(screen.getByText('You cannot read the tax rates, so the current tax is kept.')).toBeTruthy()
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  })

  it('shows a retryable tax rate error on a server failure and keeps the entered values', async () => {
    respond({ taxStatus: 500 })
    renderDialog()
    const name = await screen.findByDisplayValue('Pump (farm spec)')
    expect(screen.getByTestId('line-details-tax-failed').textContent).toContain('Could not load the tax rates.')
    expect(screen.queryByText('You cannot read the tax rates, so the current tax is kept.')).toBeNull()
    fireEvent.change(name, { target: { value: 'Pump (renamed)' } })
    respond()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(screen.queryByTestId('line-details-tax-failed')).toBeNull()
    expect(screen.getByDisplayValue('Pump (renamed)')).toBeTruthy()
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('combobox').textContent).toContain('VAT (23 %)')
  })

  it('drops a tax rate retry that answers after the dialog reloaded for another line', async () => {
    const OTHER_LINE_ID = '55555555-5555-4555-8555-555555555555'
    const props = { quoteId: QUOTE_ID, currencyCode: 'EUR', canReadTaxRates: true, lockToken: 'v1', onClose: jest.fn(), onSaved: jest.fn(), onConflict: jest.fn() }
    respond({ taxStatus: 500 })
    const view = render(<LineDetailsDialog lineId={LINE_ID} {...props} />)
    await screen.findByDisplayValue('Pump (farm spec)')
    let answerRetry: (value: unknown) => void = () => undefined
    apiCallMock.mockImplementationOnce(() => new Promise((resolve) => (answerRetry = resolve)))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    respond({ taxStatus: 500, line: { id: OTHER_LINE_ID, name: 'Other pump' } })
    view.rerender(<LineDetailsDialog lineId={OTHER_LINE_ID} {...props} />)
    await screen.findByDisplayValue('Other pump')
    await act(async () => {
      answerRetry({ ok: true, status: 200, result: { items: [{ id: 'vat-23', name: 'VAT', rate: '23' }] } })
    })
    expect(screen.getByTestId('line-details-tax-failed')).toBeTruthy()
    expect(screen.getByDisplayValue('Other pump')).toBeTruthy()
  })

  it('saves once when Cmd/Ctrl+Enter is pressed twice', async () => {
    respond()
    renderDialog()
    fireEvent.change(await screen.findByDisplayValue('Pump (farm spec)'), { target: { value: 'Other' } })
    let resolveSave: (value: unknown) => void = () => undefined
    apiCallOrThrowMock.mockReturnValueOnce(new Promise((resolve) => (resolveSave = resolve)))
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('line-details-dialog'), { key: 'Enter', metaKey: true })
      fireEvent.keyDown(screen.getByTestId('line-details-dialog'), { key: 'Enter', metaKey: true })
    })
    await act(async () => {
      resolveSave({ ok: true, status: 200, result: { lineId: LINE_ID, updatedAt: null } })
    })
    expect(apiCallOrThrowMock).toHaveBeenCalledTimes(1)
  })

  it('closes on a quote conflict, shows the conflict bar and reloads the quote', async () => {
    respond()
    conflictMock.mockReturnValue(true)
    const handlers = renderDialog()
    fireEvent.change(await screen.findByDisplayValue('Pump (farm spec)'), { target: { value: 'Other' } })
    apiCallOrThrowMock.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('line-details-save'))
    })
    expect(conflictMock).toHaveBeenCalled()
    expect(handlers.onConflict).toHaveBeenCalledTimes(1)
    expect(handlers.onClose).toHaveBeenCalled()
    expect(handlers.onSaved).not.toHaveBeenCalled()
    expect(flashMock).not.toHaveBeenCalled()
  })

  it('shows the server message of another failure and keeps the dialog open', async () => {
    respond()
    conflictMock.mockReturnValue(false)
    const handlers = renderDialog()
    fireEvent.change(await screen.findByDisplayValue('Pump (farm spec)'), { target: { value: 'Other' } })
    apiCallOrThrowMock.mockRejectedValueOnce(new Error('Not a configured line.'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('line-details-save'))
    })
    expect(flashMock).toHaveBeenCalledWith('Not a configured line.', 'error')
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it('says when the line is no longer on the quote', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [] } })
    renderDialog()
    expect((await screen.findByTestId('error-message')).textContent).toBe('This line is no longer on the quote.')
  })
})
