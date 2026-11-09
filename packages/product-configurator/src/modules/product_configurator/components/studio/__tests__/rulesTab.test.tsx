/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import type { Rule } from '../../../data/validators'
import { build } from '../../../lib/__tests__/fixtures'
import { STUDIO_NEW_ROW_KEY, type DefinitionUpdater, type StudioDefinition, type StudioIssue, type StudioTabProps } from '../tabs/types'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined

const confirmMock = jest.fn(async () => true)

jest.mock('@open-mercato/ui/backend/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, ConfirmDialogElement: null }),
}))

type MockColumn<Row> = { id: string; cell: (context: { row: { original: Row } }) => React.ReactNode }
type MockTableProps<Row> = {
  columns: MockColumn<Row>[]
  data: Row[]
  actions?: React.ReactNode
  onRowClick?: (row: Row) => void
  emptyState?: React.ReactNode
}

jest.mock('@open-mercato/ui/backend/DataTable', () => ({
  DataTable: <Row,>({ columns, data, actions, onRowClick, emptyState }: MockTableProps<Row>) => (
    <div>
      {actions}
      {data.length === 0 ? emptyState : null}
      {data.map((row, index) => (
        <div key={index} data-testid="table-row" onClick={() => onRowClick?.(row)}>
          {columns.map((column) => (
            <div key={column.id} data-column={column.id}>
              {column.cell({ row: { original: row } })}
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
}))

const renameReferenceMock = jest.fn((definition: StudioDefinition, _kind: string, _from: string, _to: string) => definition)

jest.mock('../../../lib/renameReference', () => ({
  renameReference: (definition: StudioDefinition, kind: string, from: string, to: string) => renameReferenceMock(definition, kind, from, to),
}))

import { RulesTab } from '../tabs/RulesTab'

const HEAVY_RULE: Rule = {
  id: 'heavy-cover',
  label: 'Heavy motor needs a cover',
  effect: 'error',
  when: [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }],
  messageTemplate: 'The heavy motor needs a cover.',
  featureKeys: ['motor'],
  order: 10,
}

const MAP_RULE: Rule = {
  id: 'map_colour',
  label: 'Blue instead of red',
  effect: 'force',
  when: [],
  action: { kind: 'map', featureKey: 'color', from: { red: 'blue' } },
  messageTemplate: '',
  featureKeys: [],
  order: 20,
}

const SET_LENGTH_RULE: Rule = {
  id: 'set_length',
  effect: 'force',
  when: [],
  action: { kind: 'set', featureKey: 'length', value: 10 },
  messageTemplate: '',
  featureKeys: [],
  order: 25,
}

const SURCHARGE_RULE: Rule = {
  id: 'pipe_surcharge',
  effect: 'surcharge',
  when: [],
  messageTemplate: 'Extra pipe adds ',
  featureKeys: [],
  order: 30,
}

function definitionWithRules(): StudioDefinition {
  return build((input) => {
    input.rules = [HEAVY_RULE, MAP_RULE, SET_LENGTH_RULE, SURCHARGE_RULE]
    input.bom[3] = { ...input.bom[3], ruleId: 'pipe_surcharge' }
  })
}

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  let definition = overrides.definition ?? definitionWithRules()
  const onChange = jest.fn((update: DefinitionUpdater, _referenceChange?: DefinitionUpdater) => {
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
  const view = renderWithProviders(<RulesTab {...props} />)
  return {
    onChange,
    onSelectKey,
    current: () => definition,
    rerender: (next: Partial<StudioTabProps>) => view.rerender(<RulesTab {...props} {...next} />),
    unmount: view.unmount,
  }
}

/** What renaming feature `motor` to `drive` in the Features tab does to rules. */
const renameMotorInRules: DefinitionUpdater = (definition) => ({
  ...definition,
  rules: definition.rules.map((rule) => ({
    ...rule,
    when: rule.when.map((condition) => (condition.kind === 'compare' && condition.featureKey === 'motor' ? { ...condition, featureKey: 'drive' } : condition)),
    featureKeys: rule.featureKeys.map((key) => (key === 'motor' ? 'drive' : key)),
  })),
})

function savedRule(current: () => StudioDefinition, id: string): Rule | undefined {
  return current().rules.find((rule) => rule.id === id)
}

describe('RulesTab', () => {
  beforeEach(() => {
    confirmMock.mockClear()
    renameReferenceMock.mockClear()
  })

  it('lists rules with name and id, effect, condition chips, action and message, and report problems', () => {
    const issue: StudioIssue = {
      issue: { check: 'referential_integrity', code: 'unknown_feature', params: { featureKey: 'ghost', ownerKey: 'heavy-cover' }, refs: [] },
      key: 'heavy-cover',
    }
    const { onSelectKey } = renderTab({ issues: [issue] })
    const rows = screen.getAllByTestId('table-row')
    expect(rows).toHaveLength(4)
    const heavy = within(rows[0])
    expect(heavy.getByText('Heavy motor needs a cover')).toBeTruthy()
    expect(heavy.getByText('heavy-cover')).toBeTruthy()
    expect(heavy.getByText('Blocks')).toBeTruthy()
    expect(heavy.getByText('Motor (motor) is Heavy duty 7 kW')).toBeTruthy()
    expect(heavy.getByText('The heavy motor needs a cover.')).toBeTruthy()
    expect(heavy.getByText('1 problems')).toBeTruthy()
    const map = within(rows[1])
    expect(map.getByText('Sets a value')).toBeTruthy()
    expect(map.getByText('Map Colour (color): Signal red → Gentian blue')).toBeTruthy()
    expect(map.getByText('always')).toBeTruthy()
    expect(within(rows[3]).getByText('Surcharge')).toBeTruthy()
    fireEvent.click(rows[1])
    expect(onSelectKey).toHaveBeenCalledWith('map_colour')
  })

  it('opens the selected rule with its report issues and saves edits', () => {
    const issue: StudioIssue = {
      issue: { check: 'referential_integrity', code: 'unknown_feature', params: { featureKey: 'ghost', ownerKey: 'heavy-cover' }, refs: [] },
      key: 'heavy-cover',
    }
    const { onSelectKey, current } = renderTab({ selectedKey: 'heavy-cover', issues: [issue] })
    const editor = within(screen.getByTestId('rule-editor'))
    expect(editor.getByRole('alert')).toBeTruthy()
    fireEvent.change(editor.getByLabelText('Order'), { target: { value: '15' } })
    fireEvent.click(editor.getByRole('radio', { name: 'Warns' }))
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'heavy-cover')).toEqual({ ...HEAVY_RULE, effect: 'warning', order: 15 })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })

  it('creates a rule whose highlighted fields are prefilled from the conditions', () => {
    const { current } = renderTab({ selectedKey: STUDIO_NEW_ROW_KEY })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Long pipe' } })
    fireEvent.change(editor.getByLabelText('Id'), { target: { value: 'long_pipe' } })
    fireEvent.click(editor.getByRole('button', { name: 'Feature value' }))
    expect(within(screen.getByTestId('rule-feature-keys')).getByText('Motor (motor)')).toBeTruthy()
    fireEvent.change(editor.getByLabelText('Message'), { target: { value: 'Check the pipe.' } })
    fireEvent.keyDown(editor.getByLabelText('Message'), { key: 'Enter', ctrlKey: true })
    expect(savedRule(current, 'long_pipe')).toEqual({
      id: 'long_pipe',
      label: 'Long pipe',
      effect: 'error',
      when: [{ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'standard' }],
      messageTemplate: 'Check the pipe.',
      featureKeys: ['motor'],
      order: 40,
    })
  })

  it('edits a map action with rows picked from the field options', () => {
    const { current } = renderTab({ selectedKey: 'map_colour' })
    const editor = within(screen.getByTestId('rule-editor'))
    expect(editor.getByRole('radio', { name: 'Map values' }).getAttribute('aria-checked')).toBe('true')
    expect(editor.getAllByTestId('rule-map-row')).toHaveLength(1)
    expect(editor.getByRole('group', { name: 'Row 1' })).toBeTruthy()
    fireEvent.click(editor.getByRole('button', { name: 'Remove row 1' }))
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(editor.getByText('Add at least one row.')).toBeTruthy()
    fireEvent.click(editor.getByRole('button', { name: 'Add row' }))
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'map_colour')?.action).toEqual({ kind: 'map', featureKey: 'color', from: { red: 'blue' } })
  })

  it('blocks Save and Cmd/Ctrl+Enter while a force value holds text that is not a number', () => {
    const { current, onSelectKey } = renderTab({ selectedKey: 'set_length' })
    const editor = within(screen.getByTestId('rule-editor'))
    const value = editor.getByRole('textbox', { name: 'Value' })
    fireEvent.change(value, { target: { value: 'x' } })
    const save = editor.getByRole('button', { name: 'Save rule' })
    expect(save.hasAttribute('disabled')).toBe(true)
    expect(value.getAttribute('aria-invalid')).toBe('true')
    const describedBy = value.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ').map((id) => document.getElementById(id)?.textContent)).toContain('Enter a number.')
    expect(editor.getByText('Fix the highlighted values to save the rule.')).toBeTruthy()
    fireEvent.keyDown(value, { key: 'Enter', metaKey: true })
    fireEvent.click(save)
    expect(onSelectKey).not.toHaveBeenCalled()
    expect(savedRule(current, 'set_length')?.action).toEqual({ kind: 'set', featureKey: 'length', value: 10 })

    fireEvent.change(value, { target: { value: '12.5' } })
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.keyDown(value, { key: 'Enter', ctrlKey: true })
    expect(savedRule(current, 'set_length')?.action).toEqual({ kind: 'set', featureKey: 'length', value: 12.5 })
  })

  it('blocks Save while a numeric condition is invalid and frees it when that condition is removed', () => {
    const { current } = renderTab({ selectedKey: 'heavy-cover' })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.click(editor.getByRole('button', { name: 'Calculated value' }))
    const row = within(editor.getByRole('group', { name: 'Condition 2' }))
    fireEvent.change(row.getByRole('textbox', { name: 'Value' }), { target: { value: 'abc' } })
    const save = editor.getByRole('button', { name: 'Save rule' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(savedRule(current, 'heavy-cover')).toEqual(HEAVY_RULE)

    fireEvent.click(row.getByRole('button', { name: 'Remove condition 2' }))
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.click(save)
    expect(savedRule(current, 'heavy-cover')).toEqual(HEAVY_RULE)
    expect(renameReferenceMock).not.toHaveBeenCalled()
  })

  it('renames references to the rule id when the id changes on save', () => {
    const { current } = renderTab({ selectedKey: 'pipe_surcharge' })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.change(editor.getByLabelText('Id'), { target: { value: 'pipe_extra_cost' } })
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(renameReferenceMock).toHaveBeenCalledTimes(1)
    const [renamed, kind, from, to] = renameReferenceMock.mock.calls[0]
    expect([kind, from, to]).toEqual(['rule', 'pipe_surcharge', 'pipe_extra_cost'])
    expect(renamed.rules.map((rule) => rule.id)).toContain('pipe_extra_cost')
    expect(savedRule(current, 'pipe_surcharge')).toBeUndefined()
  })

  it('switches a rule to set a value from a permitted lookup', () => {
    const { current } = renderTab({ selectedKey: 'heavy-cover' })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.click(editor.getByRole('radio', { name: 'Sets a value' }))
    fireEvent.click(editor.getByRole('radio', { name: 'Default from a permitted lookup' }))
    expect(editor.getByText(/Keyed by Motor \(motor\)/)).toBeTruthy()
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'heavy-cover')?.action).toEqual({
      kind: 'lookup_default',
      featureKey: 'motor',
      lookupKey: 'seals_by_motor',
      keyedBy: 'motor',
    })
  })

  it('inserts the line total only for the surcharge rule bound to that line', () => {
    const { current } = renderTab({ selectedKey: 'pipe_surcharge' })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.click(editor.getByRole('button', { name: 'Line total: pipe_extra' }))
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'pipe_surcharge')?.messageTemplate).toBe('Extra pipe adds {line.pipe_extra.total}')
  })

  it('hides the line total for other effects and inserts feature placeholders from the picker', () => {
    const { current } = renderTab({ selectedKey: 'heavy-cover' })
    const editor = within(screen.getByTestId('rule-editor'))
    expect(editor.queryByRole('button', { name: /Line total/ })).toBeNull()
    const message = editor.getByLabelText('Message')
    if (!(message instanceof HTMLTextAreaElement)) throw new Error('[internal] message is not a textarea')
    message.setSelectionRange(4, 4)
    fireEvent.select(message)
    const picker = editor.getByRole('combobox', { name: 'Insert a Feature placeholder' })
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false })
    fireEvent.click(picker)
    const option = screen.getByRole('option', { name: 'Pipe length (length)' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'heavy-cover')?.messageTemplate).toBe('The {feature.length}heavy motor needs a cover.')
  })

  it('reports unsaved editor edits, including text that does not parse, and clears them when the editor closes', () => {
    const onDirtyChange = jest.fn()
    const { unmount } = renderTab({ selectedKey: 'set_length', onDirtyChange })
    const editor = within(screen.getByTestId('rule-editor'))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(editor.getByLabelText('Order'), { target: { value: '26' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.change(editor.getByLabelText('Order'), { target: { value: '25' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.change(editor.getByRole('textbox', { name: 'Value' }), { target: { value: 'x' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('applies a key renamed in another tab while the editor was open to the rule it saves', () => {
    const { onChange, current, rerender } = renderTab({ selectedKey: 'heavy-cover' })
    rerender({ definition: renameMotorInRules(current()), referenceChanges: [renameMotorInRules] })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Heavy drive needs a cover' } })
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'heavy-cover')).toEqual({
      ...HEAVY_RULE,
      label: 'Heavy drive needs a cover',
      when: [{ kind: 'compare', featureKey: 'drive', op: 'eq', value: 'heavy' }],
      featureKeys: ['drive'],
    })
    expect(onChange.mock.calls[0][1]).toBeUndefined()
  })

  it('does not apply reference changes made before the editor opened again', () => {
    const { current } = renderTab({ selectedKey: 'heavy-cover', referenceChanges: [renameMotorInRules] })
    fireEvent.click(within(screen.getByTestId('rule-editor')).getByRole('button', { name: 'Save rule' }))
    expect(savedRule(current, 'heavy-cover')).toEqual(HEAVY_RULE)
  })

  it('passes the id rename to the studio as the reference change of the save', () => {
    const { onChange } = renderTab({ selectedKey: 'pipe_surcharge' })
    const editor = within(screen.getByTestId('rule-editor'))
    fireEvent.change(editor.getByLabelText('Id'), { target: { value: 'pipe_extra_cost' } })
    fireEvent.click(editor.getByRole('button', { name: 'Save rule' }))
    const referenceChange = onChange.mock.calls[0][1]
    expect(referenceChange).toEqual(expect.any(Function))
    renameReferenceMock.mockClear()
    referenceChange?.(definitionWithRules())
    expect(renameReferenceMock.mock.calls[0].slice(1)).toEqual(['rule', 'pipe_surcharge', 'pipe_extra_cost'])
  })

  it('cancels with Escape and respects read-only mode', () => {
    const { onSelectKey } = renderTab({ selectedKey: 'heavy-cover', readOnly: true })
    expect(screen.getByRole('button', { name: 'Add rule' }).hasAttribute('disabled')).toBe(true)
    const editor = within(screen.getByTestId('rule-editor'))
    expect(editor.getByRole('button', { name: 'Save rule' }).hasAttribute('disabled')).toBe(true)
    expect(editor.getByLabelText('Id').hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(editor.getByLabelText('Id'), { key: 'Escape' })
    expect(onSelectKey).toHaveBeenCalledWith(null)
  })
})
