/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelsTable } from '../ModelsTable'
import type { ModelListItem } from '../modelsApi'

const apiCallMock = jest.fn()
const routerPush = jest.fn()
let grantedFeatures: string[] = ['product_configurator.models.view']

type CapturedTableProps = {
  columns: Array<{ id?: string; cell?: (ctx: { row: { original: ModelListItem } }) => React.ReactNode }>
  data: ModelListItem[]
  error?: string | null
  isLoading?: boolean
  actions?: React.ReactNode
  emptyState?: React.ReactNode
  entityId?: string
  extensionTableId?: string
  onRowClick?: (row: ModelListItem) => void
  rowActions?: (row: ModelListItem) => React.ReactNode
  onFiltersApply?: (values: Record<string, unknown>) => void
  onSearchChange?: (value: string) => void
}

let tableProps: CapturedTableProps | null = null

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) => {
    const text = fallback ?? key
    return params ? text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? '')) : text
  },
  useLocale: () => 'en',
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 0,
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures } }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}))

jest.mock('@open-mercato/ui/backend/inputs/LookupPickers', () => ({
  useLookupLabelMap: () => ({ 'product-1': 'Telescopic loader TL-500' }),
}))

jest.mock('../lookups', () => ({
  productLookupSource: { id: 'products', search: jest.fn(), resolve: jest.fn() },
  loadCurrencyOptions: jest.fn(async () => []),
}))

jest.mock('../ModelCreateDialog', () => ({
  ModelCreateDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="create-dialog" /> : null),
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ id: string; href?: string }> }) => (
    <span>{items.map((item) => <a key={item.id} data-testid={`action-${item.id}`} href={item.href} />)}</span>
  ),
}))

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: (props: CapturedTableProps) => {
    tableProps = props
    return (
      <div data-testid="data-table">
        {props.actions}
        {props.error ? <div role="alert">{props.error}</div> : null}
        {!props.isLoading && props.data.length === 0 ? props.emptyState : null}
        {props.data.map((row) => (
          <div key={row.id} data-testid={`row-${row.id}`}>
            {props.rowActions?.(row)}
            {props.columns.map((column) => (
              <span key={column.id} data-column={column.id}>
                {column.cell ? column.cell({ row: { original: row } }) : String(row[column.id as keyof ModelListItem] ?? '')}
              </span>
            ))}
          </div>
        ))}
      </div>
    )
  },
}))

function buildModel(overrides: Partial<ModelListItem> = {}): ModelListItem {
  return {
    id: 'model-1',
    productId: 'product-1',
    modelKey: 'tl-500',
    title: 'Telescopic loader TL-500',
    currencyCode: 'EUR',
    latestVersionId: null,
    latestVersion: null,
    hasUnpublishedChanges: false,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  }
}

function mockList(items: ModelListItem[]) {
  apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items, total: items.length, totalPages: 1 } })
}

function lastRequestedQuery(): URLSearchParams {
  const url = String(apiCallMock.mock.calls[apiCallMock.mock.calls.length - 1][0])
  return new URL(url, 'http://localhost').searchParams
}

describe('ModelsTable', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
    routerPush.mockReset()
    tableProps = null
    grantedFeatures = ['product_configurator.models.view']
  })

  it('lists models with product, currency and each publish state, on a stable table id', async () => {
    const published = { id: 'v-4', version: 4, hash: 'h', publishedAt: '2026-11-01T10:00:00.000Z' }
    mockList([
      buildModel(),
      buildModel({ id: 'model-2', modelKey: 'tl-600', latestVersionId: 'v-4', latestVersion: published }),
      buildModel({ id: 'model-3', modelKey: 'tl-700', latestVersionId: 'v-4', latestVersion: published, hasUnpublishedChanges: true }),
    ])
    render(<ModelsTable />)

    await screen.findByTestId('row-model-3')
    expect(tableProps?.entityId).toBe('product_configurator:configuration_model')
    expect(tableProps?.extensionTableId).toBe('product_configurator.models')
    expect(tableProps?.columns.map((column) => column.id)).toEqual([
      'title',
      'modelKey',
      'product',
      'currencyCode',
      'publishState',
      'updatedAt',
    ])
    expect(screen.getByTestId('row-model-1').textContent).toContain('Not published')
    expect(screen.getByTestId('row-model-1').textContent).toContain('Telescopic loader TL-500')
    expect(screen.getByTestId('row-model-2').textContent).toContain('Published v4')
    expect(screen.getByTestId('row-model-2').textContent).not.toContain('Unpublished changes')
    expect(screen.getByTestId('row-model-3').textContent).toContain('Unpublished changes')
    expect(Object.fromEntries(lastRequestedQuery())).toMatchObject({ sortField: 'updatedAt', sortDir: 'desc', pageSize: '25' })
  })

  it('opens the studio on row click and links the open action to it for a manager', async () => {
    grantedFeatures = ['product_configurator.models.view', 'product_configurator.models.manage']
    mockList([buildModel()])
    render(<ModelsTable />)
    await screen.findByTestId('row-model-1')
    act(() => tableProps?.onRowClick?.(buildModel()))
    expect(routerPush).toHaveBeenCalledWith('/backend/product_configurator/models/model-1')
    expect(screen.getByTestId('action-open').getAttribute('href')).toBe('/backend/product_configurator/models/model-1')
  })

  it('sends a view-only user to the latest published version, and nowhere when none exists', async () => {
    const published = buildModel({
      id: 'model-2',
      latestVersionId: 'v-4',
      latestVersion: { id: 'v-4', version: 4, hash: 'h', publishedAt: '2026-11-01T10:00:00.000Z' },
    })
    mockList([buildModel(), published])
    render(<ModelsTable />)
    await screen.findByTestId('row-model-2')

    act(() => tableProps?.onRowClick?.(buildModel()))
    expect(routerPush).not.toHaveBeenCalled()
    act(() => tableProps?.onRowClick?.(published))
    expect(routerPush).toHaveBeenCalledWith('/backend/product_configurator/models/model-2/versions/v-4')
    const actions = screen.getAllByTestId('action-open')
    expect(actions).toHaveLength(1)
    expect(actions[0].getAttribute('href')).toBe('/backend/product_configurator/models/model-2/versions/v-4')
  })

  it('sends search and filters to the API', async () => {
    mockList([])
    render(<ModelsTable />)
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1))
    act(() => tableProps?.onFiltersApply?.({ published: 'true', currencyCode: 'EUR' }))
    act(() => tableProps?.onSearchChange?.('loader'))
    await waitFor(() =>
      expect(Object.fromEntries(lastRequestedQuery())).toMatchObject({ published: 'true', currencyCode: 'EUR', search: 'loader', page: '1' }),
    )
  })

  it('hides create actions without the manage feature', async () => {
    mockList([])
    render(<ModelsTable />)
    expect(await screen.findByText('No configuration models yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create model' })).toBeNull()
    expect(screen.getByText('An administrator creates configuration models for catalog products.')).toBeTruthy()
  })

  it('opens the create dialog for a manager', async () => {
    grantedFeatures = ['product_configurator.*']
    mockList([])
    render(<ModelsTable />)
    await screen.findByText('No configuration models yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'Create model' })[0])
    expect(screen.getByTestId('create-dialog')).toBeTruthy()
  })

  it('shows an error state when the list fails to load', async () => {
    apiCallMock.mockResolvedValue({ ok: false, status: 500, result: null })
    render(<ModelsTable />)
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load configuration models.')
  })
})
