/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { build } from '../../../lib/__tests__/fixtures'
import type { StudioTabProps } from '../tabs/types'

Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}))

jest.mock('@open-mercato/ui/backend/inputs/LookupPickers', () => ({
  LookupSinglePicker: ({ value, onChange, placeholder }: { value: string; onChange: (next: string) => void; placeholder?: string }) => (
    <input aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

jest.mock('@open-mercato/ui/primitives/date-picker', () => ({
  DatePicker: () => <span />,
}))

import { TestTab } from '../tabs/TestTab'

const CHANNEL_ID = '88888888-8888-4888-8888-888888888888'

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
    hash: 'h'.repeat(64),
    ...overrides,
  }
}

function okResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, result: body }
}

function props(overrides: Partial<StudioTabProps> = {}): StudioTabProps {
  const definition = build()
  return {
    model: { id: 'model-1', title: 'Pump', modelKey: 'pump', productId: 'product-1', currencyCode: 'EUR', latestVersion: null, hasUnpublishedChanges: true },
    definition,
    savedDefinition: definition,
    onChange: jest.fn(),
    readOnly: false,
    issues: [],
    selectedKey: null,
    onSelectKey: jest.fn(),
    onNavigate: jest.fn(),
    lockToken: null,
    onModelSaved: jest.fn(),
    onConflict: jest.fn(),
    ...overrides,
  }
}

function sentBody(callIndex: number) {
  return JSON.parse(apiCallMock.mock.calls[callIndex][1].body)
}

beforeEach(() => {
  apiCallMock.mockReset()
  apiCallMock.mockResolvedValue(okResponse({ evaluation: evaluation(), trace: { firedRules: [] }, referenceContext: true }))
})

describe('TestTab', () => {
  it('previews the saved draft in the reference context, then with a changed choice and a chosen channel', async () => {
    render(<TestTab {...props()} />)
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,000.00'))
    expect(apiCallMock.mock.calls[0][0]).toBe('/api/product_configurator/models/preview')
    expect(sentBody(0)).toEqual({ id: 'model-1', selections: {} })
    expect(screen.getByTestId('preview-reference-context')).toBeTruthy()
    expect(screen.getByText('Net price (EUR), reference context')).toBeTruthy()
    expect(screen.getByTestId('studio-test-trace').textContent).toBe('No rule fired for these choices.')
    expect(screen.queryByTestId('studio-test-unsaved')).toBeNull()

    apiCallMock.mockResolvedValue(
      okResponse({
        evaluation: evaluation({ selections: { ...evaluation().selections, motor: 'heavy' }, netPrice: '1250.00' }),
        trace: { firedRules: [{ ruleId: 'r1', label: 'Heavy seal', effect: 'force' }] },
        referenceContext: true,
      }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,250.00'))
    expect(sentBody(1)).toEqual({ id: 'model-1', selections: { motor: 'heavy' } })
    expect(screen.getByTestId('studio-test-trace').textContent).toBe('Rules that fired: Heavy seal (r1)')

    await act(async () => {
      fireEvent.change(screen.getByLabelText('No channel'), { target: { value: CHANNEL_ID } })
    })
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(3))
    expect(sentBody(2)).toEqual({ id: 'model-1', selections: { motor: 'heavy' }, context: { channelId: CHANNEL_ID, customerId: null, date: null } })
    expect(screen.getByText('Net price (EUR)')).toBeTruthy()
  })

  it('says it tests the saved draft while there are unsaved edits', async () => {
    render(<TestTab {...props({ unsavedChanges: true })} />)
    await waitFor(() => expect(apiCallMock).toHaveBeenCalled())
    expect(screen.getByTestId('studio-test-unsaved').textContent).toContain('This test uses the saved draft')
  })

  it('names the parts without a price and keeps no stale price', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 422, result: { error: 'x', code: 'price_missing', params: { skus: ['PIPE-M'], channelId: null } } })
    render(<TestTab {...props()} />)
    await waitFor(() => expect(screen.getByTestId('configurator-failure').textContent).toContain('No catalog price for PIPE-M'))
    expect(screen.getByTestId('configurator-net-price').textContent).toBe('-')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry after a server error and keeps the last good result', async () => {
    render(<TestTab {...props()} />)
    await waitFor(() => expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,000.00'))
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 500, result: null })
    await act(async () => {
      fireEvent.click(screen.getByTestId('configurator-option-motor-heavy'))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy())
    expect(screen.getByTestId('configurator-net-price').textContent).toBe('€1,000.00')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(3))
    expect(sentBody(2)).toEqual({ id: 'model-1', selections: { motor: 'heavy' } })
  })

  it('asks for a fix when the saved draft does not parse', () => {
    render(<TestTab {...props({ savedDefinition: null })} />)
    expect(screen.getByText(/needs a fix in Advanced/)).toBeTruthy()
    expect(apiCallMock).not.toHaveBeenCalled()
  })
})
