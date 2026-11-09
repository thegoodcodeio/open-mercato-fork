/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { render, screen, within } from '@testing-library/react'

Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()
let searchParams = new URLSearchParams()

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({ useOrganizationScopeVersion: () => 0 }))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <p>{label}</p>,
  ErrorMessage: ({ label }: { label: string }) => <p data-testid="error-message">{label}</p>,
  RecordNotFoundState: ({ label, backHref }: { label: string; backHref: string }) => (
    <p data-testid="not-found" data-back={backHref}>
      {label}
    </p>
  ),
}))

jest.mock('@open-mercato/ui/backend/forms', () => ({
  FormHeader: ({ title, subtitle, statusBadge, backHref }: { title: React.ReactNode; subtitle?: string; statusBadge?: React.ReactNode; backHref?: string }) => (
    <header data-back={backHref}>
      <h1>{title}</h1>
      <p data-testid="subtitle">{subtitle}</p>
      {statusBadge}
    </header>
  ),
}))

jest.mock('next/navigation', () => ({ useSearchParams: () => searchParams }))

const breadcrumbs: Array<Array<{ label: string; href?: string }>> = []
jest.mock('@open-mercato/ui/backend/AppShell', () => ({
  ApplyBreadcrumb: ({ breadcrumb }: { breadcrumb: Array<{ label: string; href?: string }> }) => {
    breadcrumbs.push(breadcrumb)
    return null
  },
}))

import { ForbiddenError } from '@open-mercato/ui/backend/utils/api'
import { SnapshotDetail } from '../SnapshotDetail'

const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const ORDER_ID = '55555555-5555-4555-8555-555555555555'

const snapshot = {
  id: 'snap-1',
  sessionId: 'session-1',
  quoteId: QUOTE_ID,
  quoteLineId: 'line-1',
  lineState: 'present',
  lineName: 'Pump (farm spec)',
  modelTitle: 'Pump',
  modelVersion: { id: 'v1', version: 3, hash: 'h' },
  summary: 'Motor: Heavy duty 7 kW; Pipe length: 2.5 m',
  selectionRows: [
    { label: 'Motor', value: 'Heavy duty 7 kW', unit: null },
    { label: 'Pipe length', value: 2.5, unit: 'm' },
    { label: 'Weather cover', value: true, unit: null },
  ],
  calculatedRows: [
    { label: 'Pipe meters', value: 3.25, unit: 'm' },
    { label: 'Rail length', value: 6, unit: 'm', decimals: 1 },
  ],
  specification: [{ label: 'Housing', value: 'Cast iron' }],
  bom: [{ sku: 'PUMP-BASE', label: 'Pump base', quantity: '1', uom: 'pc', unitPrice: '1000.0000', total: '1000.00' }],
  netPrice: '1250.00',
  currencyCode: 'EUR',
  warnings: [{ ruleId: 'w1', message: 'Heavy motors need a reinforced base.' }],
  hash: 'h',
  createdAt: '2026-11-06T10:42:00.000Z',
}

beforeEach(() => {
  apiCallMock.mockReset()
  searchParams = new URLSearchParams()
  breadcrumbs.length = 0
})

describe('SnapshotDetail', () => {
  it('reads the snapshot through the quote it was opened from and renders the read model', async () => {
    searchParams = new URLSearchParams({ quoteId: QUOTE_ID })
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot] } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect(await screen.findByText('Pump (farm spec)')).toBeTruthy()
    expect(apiCallMock.mock.calls[0][0]).toBe(`/api/product_configurator/snapshots?quoteId=${QUOTE_ID}&ids=snap-1`)
    expect(screen.getByTestId('subtitle').textContent).toContain('Model v3')
    const choices = screen.getByTestId('snapshot-choices')
    expect(within(choices).getByText('2.5 m')).toBeTruthy()
    expect(within(choices).getByText('Yes')).toBeTruthy()
    expect(within(screen.getByTestId('snapshot-calculated')).getByText('3.25 m')).toBeTruthy()
    expect(within(screen.getByTestId('snapshot-calculated')).getByText('6.0 m')).toBeTruthy()
    expect(within(screen.getByTestId('snapshot-specification')).getByText('Cast iron')).toBeTruthy()
    expect(screen.getByTestId('snapshot-warnings').textContent).toContain('Heavy motors need a reinforced base.')
    expect(within(screen.getByTestId('snapshot-bom')).getByText('PUMP-BASE')).toBeTruthy()
    expect(screen.getByTestId('snapshot-net-price').textContent).toContain('€1,250.00')
    expect(screen.getByText('On quote')).toBeTruthy()
  })

  it('reads by id without a quote and falls back to the model title when the line is gone', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { ...snapshot, lineState: 'removed', lineName: null } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect(await screen.findByText('Pump')).toBeTruthy()
    expect(apiCallMock.mock.calls[0][0]).toBe('/api/product_configurator/snapshots?id=snap-1')
    expect(screen.getByText('Line removed')).toBeTruthy()
  })

  it('shows a generic text, never the rule id, for a warning whose rule has no message', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { ...snapshot, warnings: [{ ruleId: 'w1', message: '' }] } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    const warnings = await screen.findByTestId('snapshot-warnings')
    expect(warnings.textContent).toContain('A rule of this model applies.')
    expect(warnings.textContent).not.toContain('w1')
  })

  it('shows not found when the quote does not carry the snapshot', async () => {
    searchParams = new URLSearchParams({ quoteId: QUOTE_ID })
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [] } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    const notFound = await screen.findByTestId('not-found')
    expect(notFound.getAttribute('data-back')).toBe(`/backend/sales/quotes/${QUOTE_ID}`)
  })

  it('shows the forbidden state when access is missing (apiCall throws ForbiddenError on 403)', async () => {
    apiCallMock.mockRejectedValue(new ForbiddenError('Forbidden', { requiredFeatures: ['sales.orders.view'] }))
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect((await screen.findByTestId('error-message')).textContent).toBe('You do not have access to this configuration.')
  })

  it('shows the retryable error for any other failure', async () => {
    apiCallMock.mockRejectedValue(new Error('network'))
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect((await screen.findByTestId('error-message')).textContent).toBe('Could not load the configuration details.')
  })

  it('reads the snapshot through the order it was opened from, with the order as the way back', async () => {
    searchParams = new URLSearchParams({ orderId: ORDER_ID })
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { ...snapshot, lineId: 'order-line-1', lineName: 'Pump (as ordered)' } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect(await screen.findByText('Pump (as ordered)')).toBeTruthy()
    expect(apiCallMock.mock.calls[0][0]).toBe(`/api/product_configurator/snapshots?id=snap-1&orderId=${ORDER_ID}`)
    expect(screen.getByText('On order')).toBeTruthy()
    expect(screen.getByTestId('subtitle').textContent).toContain('added Nov 6, 2026')
    expect(screen.getByTestId('subtitle').textContent).not.toContain('quote')
    expect(screen.getByTestId('snapshot-net-price').textContent).toContain('Before discounts and tax.')
    expect(screen.getByTestId('snapshot-summary').textContent).toContain('Summary on the order line')
    expect(screen.getByRole('banner').getAttribute('data-back')).toBe(`/backend/sales/orders/${ORDER_ID}`)
    expect(breadcrumbs.at(-1)?.[0]).toEqual(expect.objectContaining({ label: 'Orders', href: '/backend/sales/orders' }))
  })

  it('shows not found when the order does not carry the snapshot', async () => {
    searchParams = new URLSearchParams({ orderId: ORDER_ID })
    apiCallMock.mockResolvedValue({ ok: false, status: 404, result: { code: 'snapshot_not_found' } })
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect((await screen.findByTestId('not-found')).getAttribute('data-back')).toBe(`/backend/sales/orders/${ORDER_ID}`)
    expect(breadcrumbs.at(-1)?.[0]).toEqual(expect.objectContaining({ label: 'Orders' }))
  })

  it('keeps the order breadcrumb on the forbidden and error states', async () => {
    searchParams = new URLSearchParams({ orderId: ORDER_ID })
    apiCallMock.mockRejectedValueOnce(new ForbiddenError('Forbidden'))
    const { unmount } = render(<SnapshotDetail snapshotId="snap-1" />)
    await screen.findByTestId('error-message')
    unmount()
    breadcrumbs.length = 0
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 500, result: null })
    render(<SnapshotDetail snapshotId="snap-1" />)
    expect((await screen.findByTestId('error-message')).textContent).toBe('Could not load the configuration details.')
    expect(breadcrumbs.at(-1)?.[0]).toEqual(expect.objectContaining({ label: 'Orders' }))
  })
})
