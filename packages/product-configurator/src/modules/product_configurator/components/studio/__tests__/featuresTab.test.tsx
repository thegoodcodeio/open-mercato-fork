/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import type { Feature } from '../../../data/validators'
import { build } from '../../../lib/__tests__/fixtures'
import type { DefinitionUpdater, StudioDefinition, StudioTabProps } from '../tabs/types'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => true, ConfirmDialogElement: null }),
}))

type MockColumn<Row> = { id: string; cell: (context: { row: { original: Row } }) => React.ReactNode }

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: <Row,>({ columns, data, rowActions }: { columns: MockColumn<Row>[]; data: Row[]; rowActions?: (row: Row) => React.ReactNode }) => (
    <div>
      {data.map((row, index) => (
        <div key={index} data-testid="table-row">
          {columns.map((column) => (
            <div key={column.id} data-column={column.id}>
              {column.cell({ row: { original: row } })}
            </div>
          ))}
          {rowActions?.(row)}
        </div>
      ))}
    </div>
  ),
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ id: string; label: string }> }) => (
    <span>
      {items.map((item) => (
        <span key={item.id} data-testid={`row-action-${item.id}`}>
          {item.label}
        </span>
      ))}
    </span>
  ),
}))

const renameReferenceMock = jest.fn((definition: StudioDefinition, _kind: string, _from: string, _to: string) => definition)

jest.mock('../../../lib/renameReference', () => ({
  renameReference: (definition: StudioDefinition, kind: string, from: string, to: string) => renameReferenceMock(definition, kind, from, to),
}))

import { FeaturesTab } from '../tabs/FeaturesTab'

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  let definition = overrides.definition ?? build()
  const original = definition
  const onChange = jest.fn((update: DefinitionUpdater) => {
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
  const view = renderWithProviders(<FeaturesTab {...props} />)
  return {
    onChange,
    onSelectKey,
    original,
    current: () => definition,
    rerender: (next: Partial<StudioTabProps>) => view.rerender(<FeaturesTab {...props} {...next} />),
    unmount: view.unmount,
  }
}

function savedFeature(current: () => StudioDefinition, key: string): Feature | undefined {
  return current().features.find((feature) => feature.key === key)
}

describe('FeaturesTab', () => {
  beforeEach(() => renameReferenceMock.mockClear())

  it('saves an untouched feature without changing it', () => {
    const { current, original } = renderTab({ selectedKey: 'seal' })
    fireEvent.click(within(screen.getByTestId('feature-editor')).getByRole('button', { name: 'Save feature' }))
    expect(current().features).toEqual(original.features)
    expect(renameReferenceMock).not.toHaveBeenCalled()
  })

  it('renames references to the feature key when the key changes on save', () => {
    const { current } = renderTab({ selectedKey: 'motor' })
    const editor = within(screen.getByTestId('feature-editor'))
    fireEvent.change(editor.getByLabelText('Key'), { target: { value: 'engine' } })
    fireEvent.click(editor.getByRole('button', { name: 'Save feature' }))
    expect(renameReferenceMock).toHaveBeenCalledTimes(1)
    const [renamed, kind, from, to] = renameReferenceMock.mock.calls[0]
    expect([kind, from, to]).toEqual(['feature', 'motor', 'engine'])
    expect(renamed.features.map((feature) => feature.key)).toContain('engine')
    expect(savedFeature(current, 'motor')).toBeUndefined()
  })

  it('links a field error to its input', () => {
    renderTab({ selectedKey: 'motor' })
    const editor = within(screen.getByTestId('feature-editor'))
    const name = editor.getByLabelText('Name')
    fireEvent.change(name, { target: { value: ' ' } })
    fireEvent.click(editor.getByRole('button', { name: 'Save feature' }))
    expect(name.getAttribute('aria-invalid')).toBe('true')
    const describedBy = name.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.getAttribute('role')).toBe('alert')
  })

  it('gives every option row its own accessible name', () => {
    renderTab({ selectedKey: 'motor' })
    const editor = within(screen.getByTestId('feature-editor'))
    expect(editor.getByRole('group', { name: 'Option 1' })).toBeTruthy()
    expect(editor.getByRole('group', { name: 'Option 2' })).toBeTruthy()
  })

  it('cancels with Escape', () => {
    const { onSelectKey } = renderTab({ selectedKey: 'motor' })
    fireEvent.keyDown(within(screen.getByTestId('feature-editor')).getByLabelText('Name'), { key: 'Escape' })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('blocks Save while a numeric condition holds invalid text', () => {
    const { current, original } = renderTab({ selectedKey: 'motor' })
    const editor = within(screen.getByTestId('feature-editor'))
    fireEvent.click(editor.getByRole('button', { name: 'Calculated value' }))
    const row = within(editor.getByRole('group', { name: 'Condition 1' }))
    fireEvent.change(row.getByRole('textbox', { name: 'Value' }), { target: { value: 'abc' } })
    const save = editor.getByRole('button', { name: 'Save feature' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(save, { key: 'Enter', ctrlKey: true })
    expect(current()).toBe(original)
  })

  it('reports unsaved editor edits to the studio guard and clears them when the editor closes', () => {
    const onDirtyChange = jest.fn()
    const { unmount } = renderTab({ selectedKey: 'motor', onDirtyChange })
    const name = within(screen.getByTestId('feature-editor')).getByLabelText('Name')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    fireEvent.change(name, { target: { value: 'Drive' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.change(name, { target: { value: 'Motor' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    fireEvent.change(name, { target: { value: 'Drive' } })
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('picks the default and the options lookup with key selects that keep a value missing from the list', () => {
    const definition = build((input) => {
      input.features[0] = { ...input.features[0], default: 'retired' }
    })
    renderTab({ definition, selectedKey: 'motor' })
    const editor = within(screen.getByTestId('feature-editor'))
    expect(editor.getByRole('combobox', { name: 'Default' }).textContent).toBe('retired')
    expect(editor.getByRole('combobox', { name: 'Options from a permitted lookup' }).textContent).toBe('None: all options are allowed')
  })

  it('applies a lookup renamed in another tab while the editor was open to the feature it saves', () => {
    const renameSealLookup: DefinitionUpdater = (current) => ({
      ...current,
      features: current.features.map((feature) =>
        feature.optionsFromLookup === 'seals_by_motor' ? { ...feature, optionsFromLookup: 'seal_rules' } : feature,
      ),
    })
    const { current, rerender } = renderTab({ selectedKey: 'seal' })
    rerender({ definition: renameSealLookup(current()), referenceChanges: [renameSealLookup] })
    fireEvent.click(within(screen.getByTestId('feature-editor')).getByRole('button', { name: 'Save feature' }))
    expect(savedFeature(current, 'seal')?.optionsFromLookup).toBe('seal_rules')
  })

  it('shows the unit of a choice feature and offers no Delete in read-only mode', () => {
    const definition = build((input) => {
      input.features[0] = { ...input.features[0], unit: 'kW' }
    })
    renderTab({ definition, readOnly: true })
    expect(screen.getAllByText('Unit: kW').length).toBe(1)
    expect(screen.queryAllByTestId('row-action-delete')).toHaveLength(0)
    expect(screen.getAllByTestId('row-action-edit').length).toBeGreaterThan(0)
  })
})
