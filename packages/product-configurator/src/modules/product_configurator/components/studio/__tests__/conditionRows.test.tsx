/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import type { Condition } from '../../../data/validators'
import { build } from '../../../lib/__tests__/fixtures'
import { CommitValidityScope, useCommitValidity } from '../CommitInput'
import { ConditionRows } from '../ConditionRows'
import { describeCondition } from '../conditionRowsModel'
import { RuleActionEditor } from '../tabs/RuleActionEditor'
import type { RuleActionForm } from '../tabs/ruleForm'

Object.assign(globalThis, { TextEncoder })

const definition = build()

function ControlledRows({ initial, onChange }: { initial: Condition[]; onChange?: (next: Condition[]) => void }) {
  const [value, setValue] = React.useState(initial)
  return (
    <ConditionRows
      value={value}
      definition={definition}
      onChange={(next) => {
        onChange?.(next)
        setValue(next)
      }}
    />
  )
}

function valueInput(position: number): HTMLInputElement {
  const row = screen.getByRole('group', { name: `Condition ${position}` })
  const input = within(row).getByRole('textbox', { name: 'Value' })
  if (!(input instanceof HTMLInputElement)) throw new Error('[internal] value field is not an input')
  return input
}

describe('ConditionRows', () => {
  it('does not take hexadecimal or binary text as a number', () => {
    const onChange = jest.fn()
    renderWithProviders(<ControlledRows initial={[{ kind: 'calculated', formulaKey: 'pipe_meters', op: 'gt', value: 1 }]} onChange={onChange} />)
    for (const text of ['0x10', '0b10', '0o7', 'Infinity']) {
      fireEvent.change(valueInput(1), { target: { value: text } })
      expect(screen.getByRole('alert').textContent).toBe('Enter a number.')
    }
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(valueInput(1), { target: { value: '1e1' } })
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'calculated', formulaKey: 'pipe_meters', op: 'gt', value: 10 }])
  })

  it('keeps half-typed text with its row when an earlier row is removed', () => {
    renderWithProviders(
      <ControlledRows
        initial={[
          { kind: 'calculated', formulaKey: 'pipe_meters', op: 'gt', value: 1 },
          { kind: 'compare', featureKey: 'length', op: 'gt', value: 2 },
        ]}
      />,
    )
    fireEvent.change(valueInput(2), { target: { value: '3x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition 1' }))
    expect(screen.queryByRole('group', { name: 'Condition 2' })).toBeNull()
    expect(valueInput(1).value).toBe('3x')
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.')
  })

  it('adds a "Text contains" row with an empty value that blocks saving until a word is typed', () => {
    const onChange = jest.fn()
    function ScopedRows() {
      const { hasInvalid, validity } = useCommitValidity()
      return (
        <CommitValidityScope value={validity}>
          <ControlledRows initial={[]} onChange={onChange} />
          <span data-testid="has-invalid">{String(hasInvalid)}</span>
        </CommitValidityScope>
      )
    }
    renderWithProviders(<ScopedRows />)
    fireEvent.click(screen.getByRole('button', { name: 'Text contains' }))
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'includes', featureKey: 'motor', value: '' }])
    const row = screen.getByRole('group', { name: 'Condition 1' })
    const text = within(row).getByRole('textbox', { name: 'Text' })
    expect((text as HTMLInputElement).value).toBe('')
    expect(within(row).getByRole('alert').textContent).toBe('Enter one word without spaces.')
    expect(screen.getByTestId('has-invalid').textContent).toBe('true')
    fireEvent.change(text, { target: { value: 'hd' } })
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'includes', featureKey: 'motor', value: 'hd' }])
    expect(screen.getByTestId('has-invalid').textContent).toBe('false')
  })
})

describe('RuleActionEditor', () => {
  it('does not take hexadecimal text as the value set on a number feature', () => {
    const onChange = jest.fn()
    const action: RuleActionForm = { kind: 'set', featureKey: 'length', setValue: 2, lookupKey: '', mapRows: [] }
    renderWithProviders(<RuleActionEditor action={action} definition={definition} errors={{}} disabled={false} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Value' })
    fireEvent.change(input, { target: { value: '0x10' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.')
    fireEvent.change(input, { target: { value: '16' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...action, setValue: 16 })
  })
})

describe('describeCondition', () => {
  const templates: Record<string, string> = {
    'product_configurator.studio.conditions.describe.eq': '{value} = {feature}',
    'product_configurator.studio.conditions.describe.gte': '[{feature}] at least {value}',
    'product_configurator.studio.conditions.describe.not_includes': '{value} missing from {feature}',
    'product_configurator.studio.conditions.describe.not_in_lookup': '{feature} outside {value}',
  }
  const t = (key: string, fallback?: unknown, params?: Record<string, string | number>) => {
    const template = templates[key] ?? (typeof fallback === 'string' ? fallback : key)
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match))
  }

  it('reads each operator from one translated sentence template', () => {
    expect(describeCondition({ kind: 'compare', featureKey: 'motor', op: 'eq', value: 'heavy' }, definition, t)).toBe(
      'Heavy duty 7 kW = Motor (motor)',
    )
    expect(describeCondition({ kind: 'calculated', formulaKey: 'pipe_meters', op: 'gte', value: 4 }, definition, t)).toMatch(
      /^\[.+\] at least 4$/,
    )
    expect(describeCondition({ kind: 'not_includes', featureKey: 'motor', value: 'x' }, definition, t)).toBe('x missing from Motor (motor)')
    expect(
      describeCondition({ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }, definition, t),
    ).toMatch(/^.+ outside .*seals_by_motor/)
  })

  it('falls back to English sentences', () => {
    const plain = (key: string, fallback?: unknown, params?: Record<string, string | number>) =>
      (typeof fallback === 'string' ? fallback : key).replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      )
    expect(describeCondition({ kind: 'compare', featureKey: 'length', op: 'lt', value: 3 }, definition, plain)).toMatch(/ < 3$/)
    expect(describeCondition({ kind: 'includes', featureKey: 'motor', value: 'hd' }, definition, plain)).toBe('Motor (motor) contains hd')
  })
})
