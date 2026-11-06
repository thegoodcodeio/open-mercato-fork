/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { build } from '../../../lib/__tests__/fixtures'
import type { ValidationIssue } from '../../../lib/validation/types'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

type MockColumn<Row> = { id: string; cell: (context: { row: { original: Row } }) => React.ReactNode }
type MockTableProps<Row> = {
  columns: MockColumn<Row>[]
  data: Row[]
  actions?: React.ReactNode
  onRowClick?: (row: Row) => void
  rowActions?: (row: Row) => React.ReactNode
  emptyState?: React.ReactNode
}

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: <Row extends { key: string }>({ columns, data, actions, onRowClick, rowActions, emptyState }: MockTableProps<Row>) => (
    <div>
      {actions}
      {data.length === 0 ? emptyState : null}
      <table>
        <tbody>
          {data.map((row) => (
            <tr key={row.key} data-testid={`row-${row.key}`} onClick={() => onRowClick?.(row)}>
              {columns.map((column) => (
                <td key={column.id}>{column.cell({ row: { original: row } })}</td>
              ))}
              <td>{rowActions?.(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
}))

jest.mock('@open-mercato/ui/backend/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ id: string; label: string }> }) => (
    <span data-testid="row-actions">{items.map((item) => item.label).join(' ')}</span>
  ),
}))

const renameReferenceMock = jest.fn(<Definition,>(definition: Definition, _kind: string, _from: string, _to: string) => definition)

jest.mock('../../../lib/renameReference', () => ({
  renameReference: <Definition,>(definition: Definition, kind: string, from: string, to: string) => renameReferenceMock(definition, kind, from, to),
}))

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => true, ConfirmDialogElement: null }),
}))

import { FormulasTab } from '../tabs/FormulasTab'
import { STUDIO_NEW_ROW_KEY, type DefinitionUpdater, type StudioIssue, type StudioTabProps } from '../tabs/types'

const definition = build()

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  const onChange = jest.fn<void, [DefinitionUpdater]>()
  const onSelectKey = jest.fn()
  const props: StudioTabProps = {
    model: {
      id: 'model-1',
      title: 'Pump',
      modelKey: 'pump',
      productId: 'product-1',
      currencyCode: 'EUR',
      latestVersion: null,
      hasUnpublishedChanges: true,
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
  renderWithProviders(<FormulasTab {...props} />)
  return { onChange, onSelectKey }
}

function expressionInput(): HTMLInputElement {
  const input = screen.getByLabelText('Expression')
  if (!(input instanceof HTMLInputElement)) throw new Error('expression input is not an input')
  return input
}

function typeExpression(text: string) {
  const input = expressionInput()
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  return input
}

describe('FormulasTab', () => {
  it('lists formulas with their expression and a preview computed with the model defaults', () => {
    renderTab()
    const pipe = screen.getByTestId('row-pipe_meters')
    expect(pipe.textContent).toContain('feature.length + 0.25')
    expect(pipe.textContent).toContain('2.25 m')
    expect(screen.getByTestId('row-weight').textContent).toContain('80.0')
    expect(screen.getByTestId('row-weight').textContent).toContain('Delete')
  })

  it('marks rows that have problems in the last validation report', () => {
    const issue: ValidationIssue = { check: 'formula_cycle', code: 'formula_cycle', params: { formulaKeys: ['weight'] }, refs: [] }
    const issues: StudioIssue[] = [{ issue, key: 'weight' }]
    renderTab({ issues })
    expect(screen.getByTestId('row-weight').textContent).toContain('1 problems')
    expect(screen.getByTestId('row-pipe_meters').textContent).not.toContain('problems')
  })

  it('opens a row in the editor and offers a one-click fix for a close match', () => {
    renderTab({ selectedKey: 'weight' })
    expect(expressionInput().value).toBe('lookup.motor_weight * 2')
    expect(screen.getByTestId('formula-editor-preview').textContent).toContain('80.0')

    const input = typeExpression('lookup.motor_weigth * 2')
    expect(screen.getByText(/No lookup named "motor_weigth"\./)).toBeTruthy()
    expect(screen.getByText(/Did you mean motor_weight\?/)).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('formula-editor-preview').textContent).toContain('—')

    fireEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect(input.value).toBe('lookup.motor_weight * 2')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByTestId('formula-editor-preview').textContent).toContain('80.0')
  })

  it('tells how to write a negative reference', () => {
    renderTab({ selectedKey: 'weight' })
    typeExpression('-feature.length')
    expect(screen.getByText(/Write 0 - x or -1 \* x\./)).toBeTruthy()
  })

  it('explains that decimals use a dot', () => {
    renderTab({ selectedKey: 'weight' })
    typeExpression('feature.length * 1,5')
    expect(screen.getByText('Use a dot for decimals, for example 1.5.')).toBeTruthy()
  })

  it('autocompletes references by friendly name with arrows, Enter and Escape', () => {
    renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    const input = typeExpression('pipe')
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('formula.pipe_meters'),
      expect.stringContaining('feature.length'),
    ])
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('feature.length')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.change(input, { target: { value: 'feature.length * mot' } })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('saves a new formula into the draft', () => {
    const { onChange, onSelectKey } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Double length' } })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'double_length' } })
    typeExpression('feature.length * 2')
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'm' } })
    expect(screen.getByTestId('formula-editor-preview').textContent).toContain('4 m')

    fireEvent.click(screen.getByRole('button', { name: 'Save formula' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0](definition)
    expect(next.formulas.at(-1)).toEqual({
      key: 'double_length',
      label: 'Double length',
      expr: { kind: 'op', op: '*', left: { kind: 'feature', featureKey: 'length' }, right: { kind: 'const', value: 2 } },
      unit: 'm',
    })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('does not save with a duplicate key or an expression error, and shows the empty-expression error on save', () => {
    const { onChange } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'weight' } })
    expect(screen.queryByText('Enter an expression.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save formula' }))
    expect(screen.getByText('Enter an expression.')).toBeTruthy()
    expect(screen.getByText('Another formula already uses this key.')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renames references to the formula key when the key changes on save', () => {
    renameReferenceMock.mockClear()
    const { onChange } = renderTab({ selectedKey: 'weight' })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'motor_weight_kg' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save formula' }))
    const next = onChange.mock.calls[0][0](definition)
    expect(renameReferenceMock).toHaveBeenCalledWith(expect.anything(), 'formula', 'weight', 'motor_weight_kg')
    expect(next.formulas.map((formula) => formula.key)).toContain('motor_weight_kg')
  })

  it('does not rename references when the key stays the same', () => {
    renameReferenceMock.mockClear()
    const { onChange } = renderTab({ selectedKey: 'weight' })
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kg' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save formula' }))
    onChange.mock.calls[0][0](definition)
    expect(renameReferenceMock).not.toHaveBeenCalled()
  })

  it('cancels the editor with Escape when no suggestion list is open', () => {
    const { onSelectKey } = renderTab({ selectedKey: 'weight' })
    fireEvent.keyDown(screen.getByLabelText('Key'), { key: 'Escape' })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('links the key error to its field', () => {
    renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'weight' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save formula' }))
    const key = screen.getByLabelText('Key')
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(key.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Another formula already uses this key.')
  })

  it('respects read-only mode', () => {
    renderTab({ selectedKey: 'weight', readOnly: true })
    expect(screen.getByTestId('row-weight').textContent).toContain('Edit')
    expect(screen.getByTestId('row-weight').textContent).not.toContain('Delete')
    expect(screen.getByRole('button', { name: 'Add formula' }).hasAttribute('disabled')).toBe(true)
    expect(expressionInput().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Save formula' }).hasAttribute('disabled')).toBe(true)
  })

  it('ignores the keyboard save while the studio is read-only', () => {
    const { onChange } = renderTab({ selectedKey: 'weight', readOnly: true })
    fireEvent.keyDown(screen.getByTestId('formula-editor'), { key: 'Enter', ctrlKey: true })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports unsaved editor edits to the studio guard until the editor closes', () => {
    const onDirtyChange = jest.fn()
    renderTab({ selectedKey: 'weight', onDirtyChange })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    const unit = screen.getByLabelText('Unit')
    fireEvent.change(unit, { target: { value: 'kg' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    cleanup()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})
