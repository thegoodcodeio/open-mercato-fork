/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { build } from '../../../lib/__tests__/fixtures'
import type { BomLineDefinition } from '../../../data/validators'
import type { ValidationIssue } from '../../../lib/validation/types'
import enDict from '../../../i18n/en.json'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (url: string) => apiCallMock(url),
}))

const renameReferenceMock = jest.fn((definition: StudioDefinition, _kind: string, _from: string, _to: string) => definition)

jest.mock('../../../lib/renameReference', () => ({
  renameReference: (definition: StudioDefinition, kind: string, from: string, to: string) => renameReferenceMock(definition, kind, from, to),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => true, ConfirmDialogElement: null }),
}))

type MockColumn = { id: string; cell: (context: { row: { original: BomLineDefinition } }) => React.ReactNode }

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: ({ columns, data, actions, onRowClick, emptyState }: {
    columns: MockColumn[]
    data: BomLineDefinition[]
    actions: React.ReactNode
    onRowClick: (line: BomLineDefinition) => void
    emptyState: React.ReactNode
  }) => (
    <div>
      {actions}
      {data.length === 0 ? <p>{emptyState}</p> : null}
      <table>
        <tbody>
          {data.map((line) => (
            <tr key={line.id} data-testid={`bom-row-${line.id}`} onClick={() => onRowClick(line)}>
              {columns.map((column) => (
                <td key={column.id} data-column={column.id}>
                  {column.cell({ row: { original: line } })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
}))

import { BomTab } from '../tabs/BomTab'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioIssue, type StudioTabProps } from '../tabs/types'

const CATALOG: Record<string, { title: string; unit: string | null } | 'ambiguous'> = {
  'PUMP-BASE': { title: 'Pump housing', unit: 'pcs' },
  'MOTOR-STD': { title: 'Motor 3 kW', unit: 'pcs' },
  'MOTOR-HD': { title: 'Motor 7 kW', unit: 'set' },
  'PIPE-M': { title: 'Steel pipe', unit: 'm' },
  'HOSE-1': { title: 'Hydraulic hose', unit: 'm' },
  'DUP-1': 'ambiguous',
}

function catalogResponse(url: string) {
  const skus = decodeURIComponent(new URL(url, 'http://localhost').searchParams.get('skus') ?? '').split(',')
  const items = skus.flatMap((sku) => {
    const entry = CATALOG[sku]
    return entry && entry !== 'ambiguous' ? [{ sku, ...entry }] : []
  })
  return {
    ok: true,
    result: {
      items,
      unknown: skus.filter((sku) => !CATALOG[sku]),
      ambiguous: skus.filter((sku) => CATALOG[sku] === 'ambiguous'),
    },
  }
}

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  let definition: StudioDefinition = overrides.definition ?? build()
  const onChange = jest.fn((update: (current: StudioDefinition) => StudioDefinition) => {
    definition = update(definition)
  })
  const onSelectKey = jest.fn()
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
    onNavigate: jest.fn(),
    lockToken: null,
    onModelSaved: jest.fn(),
    onConflict: jest.fn(),
    ...overrides,
  }
  const view = renderWithProviders(<BomTab {...props} />, { dict: enDict })
  return {
    ...view,
    onChange,
    onSelectKey,
    current: () => definition,
    rerenderTab: (next: Partial<StudioTabProps>) => view.rerender(<BomTab {...props} {...next} />),
  }
}

describe('BomTab', () => {
  beforeEach(() => {
    renameReferenceMock.mockClear()
    apiCallMock.mockReset()
    apiCallMock.mockImplementation(async (url: string) => catalogResponse(url))
  })

  it('lists lines with catalog titles, lookup parts, formula quantities and catalog units', async () => {
    renderTab()
    const base = screen.getByTestId('bom-row-base')
    await waitFor(() => expect(within(base).getByText('Pump housing')).toBeTruthy())
    expect(within(base).getByText('catalog')).toBeTruthy()
    expect(apiCallMock).toHaveBeenCalledTimes(1)
    expect(apiCallMock.mock.calls[0][0]).toContain('/api/product_configurator/catalog-items?skus=')

    const motor = screen.getByTestId('bom-row-motor')
    expect(within(motor).getByText('SKU from lookup motor_skus, by Motor (motor)')).toBeTruthy()
    expect(within(motor).getByText('no common unit')).toBeTruthy()
    expect(within(motor).getByText('MOTOR-STD: pcs, MOTOR-HD: set')).toBeTruthy()

    const pipe = screen.getByTestId('bom-row-pipe')
    expect(within(pipe).getByText('pipe_meters')).toBeTruthy()
    const extra = screen.getByTestId('bom-row-pipe_extra')
    expect(within(extra).getByText('Weather cover (cover) is Yes')).toBeTruthy()
  })

  it('marks lines with report issues and shows them in the opened row editor', async () => {
    const issue: ValidationIssue = {
      check: 'bom_unit_mismatch',
      code: 'bom_unit_mismatch',
      params: { bomId: 'base', uom: 'pcs', sku: 'PUMP-BASE', unit: 'pc' },
      refs: [{ kind: 'bom', key: 'base' }],
    }
    const issues: StudioIssue[] = [{ issue, key: 'base' }]
    renderTab({ issues, selectedKey: 'base' })
    expect(within(screen.getByTestId('bom-row-base')).getByText('1 problem')).toBeTruthy()
    const editor = screen.getByTestId('bom-line-editor')
    expect(within(editor).getByText(/BOM line base uses pcs/)).toBeTruthy()
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
  })

  it('checks a typed SKU against the catalog and saves the line with the catalog unit', async () => {
    const { onChange, onSelectKey, current } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    const editor = screen.getByTestId('bom-line-editor')
    fireEvent.change(within(editor).getByLabelText('SKU'), { target: { value: 'HOSE-1' } })
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Hydraulic hose'))
    expect(within(editor).getByTestId('bom-unit').textContent).toContain('m')
    expect(apiCallMock.mock.calls.some(([url]) => String(url).includes('skus=HOSE-1'))).toBe(true)

    fireEvent.change(within(editor).getByLabelText('Quantity per configured product'), { target: { value: '2.5' } })
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save line' }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(current().bom.find((line) => line.id === 'line_5')).toEqual({
      id: 'line_5',
      sku: 'HOSE-1',
      uom: 'm',
      quantity: 2.5,
      when: [],
      order: 14,
    })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('marks unknown and ambiguous SKUs and refuses a new line without a catalog unit', async () => {
    const { onChange } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    const editor = screen.getByTestId('bom-line-editor')
    const skuInput = within(editor).getByLabelText('SKU')
    fireEvent.change(skuInput, { target: { value: 'DUP-1' } })
    await waitFor(() => expect(within(editor).getByText('Ambiguous SKU')).toBeTruthy())
    fireEvent.change(skuInput, { target: { value: 'NOPE-1' } })
    await waitFor(() => expect(within(editor).getByText('Unknown SKU')).toBeTruthy())
    expect(within(editor).getByText('Not in the catalog: NOPE-1')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save line' }))
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('explains a lookup line whose SKUs have no common unit', async () => {
    renderTab({ selectedKey: 'motor' })
    const editor = screen.getByTestId('bom-line-editor')
    expect(within(editor).getByTestId('bom-keyed-by').textContent).toBe('Motor (motor)')
    await waitFor(() =>
      expect(within(editor).getByText('The SKUs in motor_skus use different units (pcs, set). Use SKUs sold in one unit.')).toBeTruthy(),
    )
  })

  it('renames references when the id of a saved line changes, and not otherwise', async () => {
    const { current } = renderTab({ selectedKey: 'base' })
    const editor = screen.getByTestId('bom-line-editor')
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
    fireEvent.change(within(editor).getByLabelText('Line id'), { target: { value: 'housing' } })
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save line' }))
    })
    expect(renameReferenceMock).toHaveBeenCalledTimes(1)
    expect(renameReferenceMock.mock.calls[0].slice(1)).toEqual(['bom', 'base', 'housing'])
    expect(current().bom.some((line) => line.id === 'housing')).toBe(true)
  })

  it('saves an unchanged line without renaming and cancels with Escape', async () => {
    const definition = build()
    const { current, onSelectKey } = renderTab({ definition, selectedKey: 'base' })
    const editor = screen.getByTestId('bom-line-editor')
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    })
    expect(renameReferenceMock).not.toHaveBeenCalled()
    expect(current()).toEqual(definition)

    onSelectKey.mockClear()
    fireEvent.keyDown(within(editor).getByLabelText('Line id'), { key: 'Escape' })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('blocks Save while a condition value is invalid instead of saving the last valid value', async () => {
    const definition = build()
    const { current } = renderTab({ definition, selectedKey: 'base' })
    const editor = screen.getByTestId('bom-line-editor')
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
    fireEvent.click(within(editor).getByRole('button', { name: 'Calculated value' }))
    const row = within(within(editor).getByRole('group', { name: 'Condition 1' }))
    fireEvent.change(row.getByRole('textbox', { name: 'Value' }), { target: { value: 'abc' } })
    const save = within(editor).getByRole('button', { name: 'Save line' })
    expect(save.hasAttribute('disabled')).toBe(true)
    const hint = within(editor).getByText('Fix the highlighted values to save the line.')
    expect(save.getAttribute('aria-describedby')).toBe(hint.id)
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    })
    expect(current()).toEqual(definition)

    fireEvent.click(row.getByRole('button', { name: 'Remove condition 1' }))
    expect(save.hasAttribute('disabled')).toBe(false)
    expect(within(editor).queryByText('Fix the highlighted values to save the line.')).toBeNull()
  })

  it('reports unsaved editor edits to the studio guard and clears them when the editor closes', async () => {
    const onDirtyChange = jest.fn()
    const { unmount } = renderTab({ selectedKey: 'base', onDirtyChange })
    const editor = screen.getByTestId('bom-line-editor')
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    const order = within(editor).getByLabelText('Order')
    fireEvent.change(order, { target: { value: '5' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.change(order, { target: { value: '1' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    fireEvent.change(order, { target: { value: '5' } })
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('applies a formula renamed in another tab while the editor was open to the line it saves', async () => {
    const renameRunLength: (current: StudioDefinition) => StudioDefinition = (current) => ({
      ...current,
      bom: current.bom.map((line) =>
        typeof line.quantity === 'object' && line.quantity.formulaKey === 'pipe_meters'
          ? { ...line, quantity: { formulaKey: 'run_length' } }
          : line,
      ),
    })
    const { current, rerenderTab } = renderTab({ selectedKey: 'pipe' })
    rerenderTab({ referenceChanges: [renameRunLength] })
    const editor = screen.getByTestId('bom-line-editor')
    await waitFor(() => expect(within(editor).getByTestId('bom-sku-title').textContent).toBe('Steel pipe'))
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Save line' }))
    })
    expect(current().bom.find((line) => line.id === 'pipe')?.quantity).toEqual({ formulaKey: 'run_length' })
  })

  it('keeps every control disabled while the studio is read-only', async () => {
    renderTab({ selectedKey: 'base', readOnly: true })
    await waitFor(() => expect(screen.getByTestId('bom-sku-title').textContent).toBe('Pump housing'))
    expect(screen.getByRole('button', { name: 'Add line' }).hasAttribute('disabled')).toBe(true)
    const editor = screen.getByTestId('bom-line-editor')
    expect(within(editor).getByLabelText('SKU').hasAttribute('disabled')).toBe(true)
    expect(within(editor).getByRole('button', { name: 'Save line' }).hasAttribute('disabled')).toBe(true)
  })
})
