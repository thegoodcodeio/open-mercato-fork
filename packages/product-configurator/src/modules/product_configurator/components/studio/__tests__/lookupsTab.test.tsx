/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { build } from '../../../lib/__tests__/fixtures'
import type { Lookup } from '../../../data/validators'
import type { ValidationIssue } from '../../../lib/validation/types'
import enDict from '../../../i18n/en.json'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined

const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (url: string) => apiCallMock(url),
}))

const renameReferenceMock = jest.fn((definition: StudioDefinition, _kind: string, _from: string, _to: string) => definition)

jest.mock('../../../lib/renameReference', () => ({
  renameReference: (definition: StudioDefinition, kind: string, from: string, to: string) => renameReferenceMock(definition, kind, from, to),
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ id: string; label: string; onSelect: () => void }> }) => (
    <span>
      {items.map((item) => (
        <button key={item.id} type="button" onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </span>
  ),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => true, ConfirmDialogElement: null }),
}))

type MockColumn = { id: string; cell: (context: { row: { original: Lookup } }) => React.ReactNode }

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: ({ columns, data, actions, onRowClick, rowActions }: {
    columns: MockColumn[]
    data: Lookup[]
    actions: React.ReactNode
    onRowClick: (lookup: Lookup) => void
    rowActions: (lookup: Lookup) => React.ReactNode
  }) => (
    <div>
      {actions}
      <table>
        <tbody>
          {data.map((lookup) => (
            <tr key={lookup.key} data-testid={`lookup-row-${lookup.key}`} onClick={() => onRowClick(lookup)}>
              {columns.map((column) => (
                <td key={column.id}>{column.cell({ row: { original: lookup } })}</td>
              ))}
              <td onClick={(event) => event.stopPropagation()}>{rowActions(lookup)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
}))

import { LookupsTab } from '../tabs/LookupsTab'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioIssue, type StudioTabProps } from '../tabs/types'

const CATALOG: Record<string, string | 'ambiguous'> = { 'MOTOR-STD': 'Motor 3 kW', 'DUP-1': 'ambiguous' }

function catalogResponse(url: string) {
  const skus = decodeURIComponent(new URL(url, 'http://localhost').searchParams.get('skus') ?? '').split(',')
  return {
    ok: true,
    result: {
      items: skus.flatMap((sku) => {
        const title = CATALOG[sku]
        return title && title !== 'ambiguous' ? [{ sku, title, unit: 'pcs' }] : []
      }),
      unknown: skus.filter((sku) => !CATALOG[sku]),
      ambiguous: skus.filter((sku) => CATALOG[sku] === 'ambiguous'),
    },
  }
}

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  let definition: StudioDefinition = overrides.definition ?? build()
  const onChange = jest.fn((update: (current: StudioDefinition) => StudioDefinition, _referenceChange?: (current: StudioDefinition) => StudioDefinition) => {
    definition = update(definition)
  })
  const onSelectKey = jest.fn()
  const onNavigate = jest.fn()
  const props: StudioTabProps = {
    model: {
      id: 'model-1',
      title: 'Pump',
      modelKey: 'pump',
      productId: 'product-1',
      currencyCode: 'EUR',
      latestVersion: null,
      hasUnpublishedChanges: false,
    },
    definition,
    savedDefinition: definition,
    onChange,
    readOnly: false,
    issues: [],
    selectedKey: null,
    onSelectKey,
    onNavigate,
    lockToken: null,
    onModelSaved: jest.fn(),
    onConflict: jest.fn(),
    ...overrides,
  }
  const view = renderWithProviders(<LookupsTab {...props} />, { dict: enDict })
  return { ...view, onChange, onSelectKey, onNavigate, current: () => definition }
}

describe('LookupsTab', () => {
  beforeEach(() => {
    renameReferenceMock.mockClear()
    apiCallMock.mockReset()
    apiCallMock.mockImplementation(async (url: string) => catalogResponse(url))
  })

  it('lists lookups with friendly name, key, type, key feature, row count and missing rows', () => {
    const definition = build((input) => {
      const lookup = input.lookups.find((entry) => entry.key === 'motor_weight')
      if (lookup) lookup.label = 'Motor weight'
      if (lookup?.kind === 'value') lookup.rows = [{ match: 'standard', value: 40 }]
    })
    renderTab({ definition })
    const row = screen.getByTestId('lookup-row-motor_weight')
    expect(within(row).getByText('Motor weight')).toBeTruthy()
    expect(within(row).getByText('motor_weight')).toBeTruthy()
    expect(within(row).getByText('Value')).toBeTruthy()
    expect(within(row).getByText('Motor (motor)')).toBeTruthy()
    expect(within(row).getByText('1')).toBeTruthy()
    expect(within(row).getByText('Options without a row: 1')).toBeTruthy()
    expect(within(screen.getByTestId('lookup-row-seals_by_motor')).getByText('Permitted options')).toBeTruthy()
  })

  it('checks SKU values against the catalog when the lookup is opened and when a row is edited', async () => {
    const issue: ValidationIssue = {
      check: 'referential_integrity',
      code: 'unknown_sku',
      params: { sku: 'MOTOR-HD', bomId: 'motor' },
      refs: [{ kind: 'lookup', key: 'motor_skus' }],
    }
    const issues: StudioIssue[] = [{ issue, key: 'motor_skus' }]
    renderTab({ selectedKey: 'motor_skus', issues })
    expect(within(screen.getByTestId('lookup-row-motor_skus')).getByText('1 problem')).toBeTruthy()
    const editor = screen.getByTestId('lookup-editor')
    expect(within(editor).getByTestId('lookup-usage').textContent).toContain('BOM line motor')
    await waitFor(() => expect(within(editor).getByText('Motor 3 kW')).toBeTruthy())
    expect(within(editor).getByText('Unknown SKU: not found in the catalog.')).toBeTruthy()
    expect(apiCallMock).toHaveBeenCalledTimes(1)
    expect(apiCallMock.mock.calls[0][0]).toBe('/api/product_configurator/catalog-items?skus=MOTOR-STD%2CMOTOR-HD')

    fireEvent.change(within(editor).getByLabelText('Value for Heavy duty 7 kW'), { target: { value: 'DUP-1' } })
    await waitFor(() => expect(within(editor).getByText('Ambiguous SKU: a product and a variant both use it.')).toBeTruthy())
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    expect(apiCallMock.mock.calls[1][0]).toContain('skus=DUP-1')
  })

  it('says when the catalog check cannot run', async () => {
    apiCallMock.mockImplementation(async () => ({ ok: false, status: 403, result: { error: 'Forbidden' } }))
    renderTab({ selectedKey: 'motor_skus' })
    const editor = screen.getByTestId('lookup-editor')
    await waitFor(() => expect(within(editor).getAllByText('Catalog check unavailable. Validate checks the saved draft.')).toHaveLength(2))
  })

  it('warns about options without a row and saves the value lookup into the draft', async () => {
    const { onChange, onSelectKey, current } = renderTab({ selectedKey: 'motor_weight' })
    const editor = screen.getByTestId('lookup-editor')
    expect(within(editor).getByTestId('lookup-coverage').textContent).toBe('Every Motor (motor) option has a row.')
    fireEvent.change(within(editor).getByLabelText('Value for Heavy duty 7 kW'), { target: { value: '' } })
    expect(within(editor).getByTestId('lookup-coverage').textContent).toContain('No row for Heavy duty 7 kW of Motor (motor)')
    fireEvent.change(within(editor).getByLabelText('Value for Standard 3 kW'), { target: { value: '42' } })
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save lookup' }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(current().lookups.find((lookup) => lookup.key === 'motor_weight')).toEqual({
      kind: 'value',
      key: 'motor_weight',
      keyedBy: 'motor',
      rows: [{ match: 'standard', value: 42 }],
    })
    expect(onSelectKey).toHaveBeenCalledWith(null)
    expect(apiCallMock).not.toHaveBeenCalled()
  })

  it('edits a permitted lookup with allowed chips and a default restricted to them', async () => {
    const { current } = renderTab({ selectedKey: 'seals_by_motor' })
    const editor = screen.getByTestId('lookup-editor')
    expect(within(editor).getByTestId('lookup-usage').textContent).toBe('Limits the options of Seal (seal).')
    const standard = within(editor).getByRole('group', { name: 'Allowed values for Standard 3 kW' })
    const epdm = within(standard).getByRole('button', { name: 'EPDM' })
    expect(epdm.getAttribute('aria-pressed')).toBe('true')
    expect(within(standard).getByRole('button', { name: 'PTFE' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(epdm)
    fireEvent.click(within(standard).getByRole('button', { name: 'PTFE' }))
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    })
    expect(current().lookups.find((lookup) => lookup.key === 'seals_by_motor')).toEqual({
      kind: 'permitted',
      key: 'seals_by_motor',
      keyedBy: 'motor',
      rows: [
        { match: 'standard', values: ['viton', 'ptfe'], default: 'viton' },
        { match: 'heavy', values: ['viton', 'ptfe'], default: 'viton' },
      ],
    })
  })

  it('pages a large lookup, finds rows by search and points bulk changes to Advanced (JSON)', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ match: String(index + 1), value: index * 10 }))
    const definition = build((input) => {
      input.lookups.push({ kind: 'value', key: 'by_length', label: 'By length', keyedBy: 'length', rows })
    })
    const { onNavigate } = renderTab({ definition, selectedKey: 'by_length' })
    const editor = screen.getByTestId('lookup-editor')
    expect(within(editor).getAllByTestId('lookup-value-row')).toHaveLength(50)
    expect(within(editor).queryByTestId('lookup-coverage')).toBeNull()

    fireEvent.change(within(editor).getByLabelText('Find a row'), { target: { value: '1180' } })
    const found = within(editor).getAllByTestId('lookup-value-row')
    expect(found).toHaveLength(1)
    expect((within(found[0]).getByLabelText('Value for 119') as HTMLInputElement).value).toBe('1180')

    fireEvent.click(within(editor).getByRole('button', { name: 'Open Advanced (JSON)' }))
    expect(onNavigate).toHaveBeenCalledWith('advanced')
  })

  it('creates a lookup and refuses a duplicate key', async () => {
    const { onChange } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    const editor = screen.getByTestId('lookup-editor')
    fireEvent.change(within(editor).getByLabelText('Key'), { target: { value: 'motor_skus' } })
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save lookup' }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(within(editor).getByText('Another lookup already uses this key.')).toBeTruthy()
  })

  it('retries the catalog check after a failure', async () => {
    apiCallMock.mockImplementation(async () => ({ ok: false, status: 500, result: null }))
    renderTab({ selectedKey: 'motor_skus' })
    const editor = screen.getByTestId('lookup-editor')
    await waitFor(() => expect(within(editor).getAllByText('Catalog check unavailable. Validate checks the saved draft.')).toHaveLength(2))
    apiCallMock.mockImplementation(async (url: string) => catalogResponse(url))
    fireEvent.change(within(editor).getByLabelText('Value for Heavy duty 7 kW'), { target: { value: 'DUP-1' } })
    await waitFor(() => expect(within(editor).getByText('Motor 3 kW')).toBeTruthy())
    expect(within(editor).getByText('Ambiguous SKU: a product and a variant both use it.').className).toContain('text-status-error-text')
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    expect(apiCallMock.mock.calls[1][0]).toBe('/api/product_configurator/catalog-items?skus=MOTOR-STD%2CDUP-1')
  })

  it('renames references when the key of a saved lookup changes', async () => {
    const { current } = renderTab({ selectedKey: 'motor_weight' })
    const editor = screen.getByTestId('lookup-editor')
    fireEvent.change(within(editor).getByLabelText('Key'), { target: { value: 'motor_mass' } })
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save lookup' }))
    })
    expect(renameReferenceMock).toHaveBeenCalledTimes(1)
    expect(renameReferenceMock.mock.calls[0].slice(1)).toEqual(['lookup', 'motor_weight', 'motor_mass'])
    expect(current().lookups.some((lookup) => lookup.key === 'motor_mass')).toBe(true)
  })

  it('saves an unchanged lookup without renaming and gives free rows distinct names', async () => {
    const definition = build((input) => {
      input.lookups.push({ kind: 'value', key: 'by_length', keyedBy: 'length', rows: [{ match: '1', value: '007' }] })
    })
    const { current } = renderTab({ definition, selectedKey: 'by_length' })
    const editor = screen.getByTestId('lookup-editor')
    fireEvent.click(within(editor).getByRole('button', { name: 'Add row' }))
    expect(within(editor).getByLabelText('Row 1: when Pipe length (length) is')).toBeTruthy()
    expect(within(editor).getByLabelText('Row 2: when Pipe length (length) is')).toBeTruthy()
    expect(within(editor).getByLabelText('Value for #2')).toBeTruthy()
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove row #2' }))
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    })
    expect(renameReferenceMock).not.toHaveBeenCalled()
    expect(current()).toEqual(definition)
  })

  it('counts a row as covering an option only when its match equals the option exactly', () => {
    const definition = build((input) => {
      input.features.find((entry) => entry.key === 'motor')?.options?.push({ value: 'long ', label: 'Long', order: 3 })
      const lookup = input.lookups.find((entry) => entry.key === 'motor_weight')
      if (lookup?.kind === 'value') lookup.rows.push({ match: 'long ', value: 90 })
    })
    renderTab({ definition, selectedKey: 'motor_weight' })
    expect(within(screen.getByTestId('lookup-editor')).getByTestId('lookup-coverage').textContent).toBe('Every Motor (motor) option has a row.')
  })

  it('cancels with Escape', () => {
    const { onSelectKey, onChange } = renderTab({ selectedKey: 'motor_weight' })
    fireEvent.keyDown(screen.getByLabelText('Key'), { key: 'Escape' })
    expect(onSelectKey).toHaveBeenCalledWith(null)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('points the keyedBy of every consumer at the new key feature when it changes', async () => {
    const definition = build((input) => {
      input.features[4] = {
        ...input.features[4],
        visibleWhen: [{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }],
      }
    })
    const { current, onChange } = renderTab({ definition, selectedKey: 'seals_by_motor' })
    const editor = screen.getByTestId('lookup-editor')
    const keyedBy = within(editor).getByRole('combobox', { name: 'Keyed by' })
    fireEvent.pointerDown(keyedBy, { button: 0, ctrlKey: false })
    fireEvent.click(keyedBy)
    const option = screen.getByRole('option', { name: 'Pipe length (length)' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save lookup' }))
    })
    expect(current().lookups.find((lookup) => lookup.key === 'seals_by_motor')?.keyedBy).toBe('length')
    expect(current().features[4].visibleWhen).toEqual([{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'length' }])
    expect(onChange.mock.calls[0][1]).toEqual(expect.any(Function))
  })

  it('reports typed values to the studio guard but not the blank rows it adds itself', async () => {
    const onDirtyChange = jest.fn()
    const { unmount } = renderTab({ selectedKey: 'motor_weight', onDirtyChange })
    await act(async () => undefined)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
    fireEvent.change(screen.getByLabelText('Value for Standard 3 kW'), { target: { value: '41' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('ignores the keyboard save while the studio is read-only', async () => {
    const { onChange } = renderTab({ selectedKey: 'motor_weight', readOnly: true })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('lookup-editor'), { key: 'Enter', ctrlKey: true })
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables editing while the studio is read-only', () => {
    renderTab({ selectedKey: 'motor_weight', readOnly: true })
    const row = screen.getByTestId('lookup-row-motor_weight')
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull()
    const editor = screen.getByTestId('lookup-editor')
    expect((within(editor).getByRole('button', { name: 'Save lookup' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(editor).getByLabelText('Value for Standard 3 kW') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Add lookup' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
