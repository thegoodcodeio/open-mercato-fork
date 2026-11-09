/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()
let itemsContext: { documentId: string; kind: 'order' | 'quote' } | null = null

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

jest.mock('@open-mercato/core/modules/sales/widgets/injection/order-items-context', () => ({
  useOrderItemsInjectionContext: () => itemsContext,
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
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { emitOrganizationScopeChanged } from '@open-mercato/shared/lib/frontend/organizationEvents'
import { OrderConfigurationsTab } from '../OrderConfigurationsTab'
import { ConfiguredLineCell } from '../ConfiguredLineColumn'
import { clearOrderSnapshotsCache } from '../orderApi'

const ORDER_ID = '55555555-5555-4555-8555-555555555555'

function snapshot(id: string, lineId: string) {
  return {
    id,
    sessionId: `session-${id}`,
    quoteId: 'gone',
    quoteLineId: lineId,
    lineState: 'present',
    lineId,
    lineName: `Pump ${id}`,
    modelTitle: 'Pump',
    modelVersion: { id: 'v1', version: 3, hash: 'h' },
    summary: 'Motor: Heavy duty',
    selectionRows: [],
    calculatedRows: [],
    specification: [],
    bom: [],
    netPrice: '1250.00',
    currencyCode: 'EUR',
    warnings: [],
    hash: 'h',
    createdAt: '2026-11-06T10:00:00.000Z',
  }
}

beforeEach(() => {
  apiCallMock.mockReset()
  clearOrderSnapshotsCache()
  itemsContext = { documentId: ORDER_ID, kind: 'order' }
})

describe('OrderConfigurationsTab', () => {
  it('lists the configured order lines read-only with links that carry the order', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot('s1', 'line-1')], truncated: false } })
    render(<OrderConfigurationsTab orderId={ORDER_ID} />)
    const card = await screen.findByTestId('order-configured-line-s1')
    expect(apiCallMock.mock.calls[0][0]).toBe(`/api/product_configurator/snapshots?orderId=${ORDER_ID}`)
    expect(card.textContent).toContain('Pump s1')
    expect(card.textContent).toContain('Motor: Heavy duty')
    expect(card.textContent).toContain('v3')
    expect(card.textContent).toContain('€1,250.00')
    expect(screen.getByRole('link', { name: 'Configuration details' }).getAttribute('href')).toBe(
      `/backend/product_configurator/snapshots/s1?orderId=${ORDER_ID}`,
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the empty state, and an error with Retry instead of an empty list', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 500, result: null })
    render(<OrderConfigurationsTab orderId={ORDER_ID} />)
    const error = await screen.findByTestId('error-message')
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { items: [] } })
    fireEvent.click(error.querySelector('button') as HTMLButtonElement)
    expect(await screen.findByTestId('empty-state')).toBeTruthy()
  })

  it('asks for one organization instead of an error while all organizations are selected', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 400, result: { error: 'Select an organization', code: 'organization_scope_required' } })
    render(<OrderConfigurationsTab orderId={ORDER_ID} />)
    expect((await screen.findByTestId('error-message')).textContent).toBe(
      'Select one organization in the top bar to see the configurations of this order.',
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('ConfiguredLineCell', () => {
  it('marks a configured order line with a link to its details and leaves other lines empty', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot('s1', 'line-1')] } })
    const { container } = render(
      <>
        <ConfiguredLineCell getValue={() => 'line-1'} />
        <ConfiguredLineCell getValue={() => 'line-2'} />
      </>,
    )
    expect(screen.getAllByRole('status', { name: 'Loading' })).toHaveLength(2)
    const cell = await screen.findByTestId('order-item-configured-line-1')
    expect(cell.textContent).toContain('Configured')
    expect(screen.getByRole('link', { name: 'Configuration details of Pump s1' }).getAttribute('href')).toBe(
      `/backend/product_configurator/snapshots/s1?orderId=${ORDER_ID}`,
    )
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(container.textContent).not.toContain('Loading')
    expect(screen.queryByTestId('order-item-configured-line-2')).toBeNull()
    expect(apiCallMock).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while all organizations are selected', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 400, result: { code: 'organization_scope_required' } })
    const { container } = render(<ConfiguredLineCell getValue={() => 'line-1'} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('reloads when the organization selection changes, without reusing the load of the other selection', async () => {
    const selectOrganization = (organizationId: string | null) =>
      act(() => emitOrganizationScopeChanged({ organizationId, tenantId: 'tenant-1' }))
    const organizationRequired = { ok: false, status: 400, result: { code: 'organization_scope_required' } }
    selectOrganization(null)
    apiCallMock.mockResolvedValue(organizationRequired)
    const { container } = render(<ConfiguredLineCell getValue={() => 'line-1'} />)
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.textContent).toBe(''))

    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot('s1', 'line-1')] } })
    selectOrganization('org-1')
    expect(await screen.findByTestId('order-item-configured-line-1')).toBeTruthy()

    apiCallMock.mockResolvedValue(organizationRequired)
    selectOrganization(null)
    await waitFor(() => expect(screen.queryByTestId('order-item-configured-line-1')).toBeNull())
    await waitFor(() => expect(container.textContent).toBe(''))
    expect(apiCallMock).toHaveBeenCalledTimes(3)
  })

  it('renders nothing outside an order', () => {
    itemsContext = { documentId: 'quote-1', kind: 'quote' }
    const { container } = render(<ConfiguredLineCell getValue={() => 'line-1'} />)
    expect(container.textContent).toBe('')
    expect(apiCallMock).not.toHaveBeenCalled()
  })
})
