/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

Object.assign(globalThis, { TextEncoder })
Element.prototype.scrollIntoView = jest.fn()

const apiCallMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const messages: Record<string, string> = {
    'product_configurator.quoteNotice.text.one': 'This quote has 1 configured line. Edit it in the {link}.',
  }
  return {
    useT: () => (key: string, fallbackOrParams?: string | Record<string, string | number>, maybeParams?: Record<string, string | number>) => {
      const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined
      const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : maybeParams
      const template = messages[key] ?? fallback ?? key
      return template.replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token))
    },
    useLocale: () => 'en',
  }
})

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  ErrorMessage: ({ label }: { label: string }) => <p data-testid="error-message">{label}</p>,
}))

import { emitOrganizationScopeChanged } from '@open-mercato/shared/lib/frontend/organizationEvents'
import { ConfiguredLinesNotice } from '../ConfiguredLinesNotice'

const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'

function selectOrganization(organizationId: string | null) {
  act(() => emitOrganizationScopeChanged({ organizationId, tenantId: TENANT_ID }))
}

function organizationRequired() {
  apiCallMock.mockResolvedValue({ ok: false, status: 400, result: { code: 'organization_scope_required' } })
}

function snapshots(states: Array<'present' | 'removed'>) {
  return { items: states.map((lineState, index) => ({ id: `s${index}`, lineState })) }
}

function respond(payload: { items: Array<Record<string, unknown>>; truncated?: boolean }) {
  const full = {
    truncated: payload.truncated,
    items: payload.items.map((item) => ({
      sessionId: 'x',
      quoteId: QUOTE_ID,
      quoteLineId: null,
      lineName: null,
      modelTitle: 'Pump',
      modelVersion: { id: 'v', version: 1, hash: 'h' },
      summary: '',
      selectionRows: [],
      calculatedRows: [],
      specification: [],
      bom: [],
      netPrice: '1.00',
      currencyCode: 'EUR',
      warnings: [],
      hash: 'h',
      createdAt: '2026-11-06T10:00:00.000Z',
      ...item,
    })),
  }
  apiCallMock.mockResolvedValue({ ok: true, status: 200, result: full })
}

beforeEach(() => {
  apiCallMock.mockReset()
  document.body.innerHTML = ''
})

describe('ConfiguredLinesNotice', () => {
  it('counts the configured lines still on the quote and opens the Configurations tab', async () => {
    respond(snapshots(['present', 'removed', 'present']))
    const tabButton = document.createElement('button')
    tabButton.setAttribute('data-tab-id', 'product_configurator.injection.quote-configurations-tab')
    const clicked = jest.fn()
    tabButton.addEventListener('click', clicked)
    document.body.appendChild(tabButton)

    render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt="2026-11-06T10:00:00.000Z" />)
    const notice = await screen.findByTestId('quote-configured-lines-notice')
    expect(apiCallMock.mock.calls[0][0]).toBe(`/api/product_configurator/snapshots?quoteId=${QUOTE_ID}`)
    expect(notice.textContent).toBe('This quote has 2 configured lines. Edit their name, comment, discount and tax in the Configurations tab.')
    fireEvent.click(screen.getByRole('button', { name: 'Configurations tab' }))
    expect(clicked).toHaveBeenCalled()
  })

  it('uses the singular form for one line and reloads when the quote changes', async () => {
    respond(snapshots(['present']))
    const { rerender } = render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt="a" />)
    expect((await screen.findByTestId('quote-configured-lines-notice')).textContent).toBe('This quote has 1 configured line. Edit it in the Configurations tab.')
    respond(snapshots(['removed']))
    rerender(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt="b" />)
    await waitFor(() => expect(screen.queryByTestId('quote-configured-lines-notice')).toBeNull())
    expect(apiCallMock).toHaveBeenCalledTimes(2)
  })

  it('shows the tab name as plain text when the Configurations tab button is not on the page, and a link once it appears', async () => {
    respond(snapshots(['present', 'present']))
    render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt={null} />)
    const notice = await screen.findByTestId('quote-configured-lines-notice')
    expect(notice.textContent).toContain('in the Configurations tab.')
    expect(screen.queryByRole('button', { name: 'Configurations tab' })).toBeNull()

    const tabButton = document.createElement('button')
    tabButton.setAttribute('data-tab-id', 'product_configurator.injection.quote-configurations-tab')
    document.body.appendChild(tabButton)
    expect(await screen.findByRole('button', { name: 'Configurations tab' })).toBeTruthy()

    tabButton.remove()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Configurations tab' })).toBeNull())
    expect(screen.getByTestId('quote-configured-lines-notice').textContent).toContain('in the Configurations tab.')
  })

  it('appears once one organization is selected after all, and goes away when all are selected again', async () => {
    selectOrganization(null)
    organizationRequired()
    const { container } = render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt={null} />)
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1))
    await act(async () => undefined)
    expect(container.textContent).toBe('')

    respond(snapshots(['present', 'present']))
    selectOrganization(ORG_ID)
    expect((await screen.findByTestId('quote-configured-lines-notice')).textContent).toContain('2 configured lines')

    organizationRequired()
    selectOrganization(null)
    expect(screen.queryByTestId('quote-configured-lines-notice')).toBeNull()
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(3))
    await act(async () => undefined)
    expect(container.textContent).toBe('')
  })

  it('renders nothing while all organizations are selected', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 400, result: { code: 'organization_scope_required' } })
    const { container } = render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt={null} />)
    await waitFor(() => expect(apiCallMock).toHaveBeenCalled())
    await act(async () => undefined)
    expect(container.textContent).toBe('')
  })

  it('counts the configured quote lines from their markers when the snapshot list is truncated, skipping malformed markers', async () => {
    const lines = [
      { id: 'l1', configuration: { productConfigurator: { snapshotId: '00000000-0000-4000-8000-000000000001' } } },
      { id: 'l2', configuration: { productConfigurator: { snapshotId: '00000000-0000-4000-8000-000000000002' } } },
      { id: 'l3', configuration: JSON.stringify({ productConfigurator: { snapshotId: '00000000-0000-4000-8000-000000000003' } }) },
      { id: 'l4', configuration: null },
      { id: 'l5', configuration: { productConfigurator: { snapshotId: 'not-a-uuid' } } },
      { id: 'l6', configuration: '{not json' },
    ]
    respond({ ...snapshots(['present']), truncated: true })
    const snapshotsResponse = apiCallMock.getMockImplementation()
    apiCallMock.mockImplementation((url: string) =>
      url.startsWith('/api/sales/quote-lines') ? Promise.resolve({ ok: true, status: 200, result: { items: lines } }) : snapshotsResponse?.(url),
    )
    render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt={null} />)
    const notice = await screen.findByTestId('quote-configured-lines-notice')
    expect(notice.textContent).toContain('This quote has 3 configured lines.')
    expect(apiCallMock.mock.calls[1][0]).toBe(`/api/sales/quote-lines?quoteId=${QUOTE_ID}&page=1&pageSize=100`)
  })

  it('shows an error when the configured lines cannot be read', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 500, result: null })
    render(<ConfiguredLinesNotice quoteId={QUOTE_ID} quoteUpdatedAt={null} />)
    expect(await screen.findByTestId('error-message')).toBeTruthy()
  })
})
