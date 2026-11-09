/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { build } from '../../../lib/__tests__/fixtures'
import type { SelectionValue } from '../../../data/validators'

Object.assign(globalThis, { TextEncoder })

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? key).replace(/\{(\w+)\}/g, (token, name: string) => (params && name in params ? String(params[name]) : token)),
  useLocale: () => 'en',
}))

import { FeatureField } from '../FeatureField'

const definition = build((input) => {
  input.features.push({
    key: 'size',
    label: 'Size',
    type: 'choice',
    options: [
      { value: 'xs', label: 'Extra small', order: 1 },
      { value: 's', label: 'Small', order: 2 },
      { value: 'm', label: 'Medium', order: 3 },
      { value: 'l', label: 'Large', order: 4 },
    ],
    default: 'xs',
    order: 20,
    inSummary: false,
  })
})
const feature = definition.features.find((entry) => entry.key === 'size')
if (!feature) throw new Error('[internal] size feature missing')
const sizeFeature = feature

function Harness({ initial, allowedValues, onChange }: { initial: string; allowedValues: string[] | null; onChange: (value: SelectionValue) => void }) {
  const [value, setValue] = React.useState<SelectionValue>(initial)
  return (
    <FeatureField
      definition={definition}
      feature={sizeFeature}
      value={value}
      allowedValues={allowedValues}
      forcedBy={null}
      serverError={null}
      highlighted={false}
      resetGeneration={0}
      onChange={(next) => {
        onChange(next)
        setValue(next)
      }}
      onInvalidChange={() => undefined}
    />
  )
}

function option(value: string): HTMLElement {
  return screen.getByTestId(`configurator-option-size-${value}`)
}

function press(element: HTMLElement, key: string) {
  fireEvent.keyDown(element, { key })
  fireEvent.keyUp(element, { key })
}

describe('FeatureField choice radio group', () => {
  it('chooses the next option on a quick arrow press, once per press, and moves focus to it', () => {
    const onChange = jest.fn()
    render(<Harness initial="xs" allowedValues={null} onChange={onChange} />)

    act(() => option('xs').focus())
    press(option('xs'), 'ArrowRight')
    expect(onChange.mock.calls).toEqual([['s']])
    expect(option('s').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(option('s'))

    press(option('s'), 'ArrowDown')
    press(option('m'), 'ArrowLeft')
    press(option('s'), 'ArrowUp')
    expect(onChange.mock.calls).toEqual([['s'], ['m'], ['s'], ['xs']])
    expect(document.activeElement).toBe(option('xs'))
  })

  it('skips options the current choices do not allow and wraps around the ends', () => {
    const onChange = jest.fn()
    render(<Harness initial="s" allowedValues={['xs', 's', 'l']} onChange={onChange} />)

    press(option('s'), 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('l')
    press(option('l'), 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('xs')
    press(option('xs'), 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('l')
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(option('m').getAttribute('aria-checked')).toBe('false')
  })

  it('describes the radio group with the reason of the options arrow keys skip', () => {
    const { rerender } = render(<Harness initial="s" allowedValues={['xs', 's', 'l']} onChange={() => undefined} />)
    const group = screen.getByRole('radiogroup')
    const reasonId = group.getAttribute('aria-describedby')
    expect(reasonId).toBeTruthy()
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe('Medium: Not available with the current choices.')
    expect(option('m').getAttribute('aria-describedby')).toBe(reasonId)

    rerender(<Harness initial="s" allowedValues={null} onChange={() => undefined} />)
    expect(screen.getByRole('radiogroup').hasAttribute('aria-describedby')).toBe(false)
  })

  it('leaves other keys to the radio group', () => {
    const onChange = jest.fn()
    render(<Harness initial="xs" allowedValues={null} onChange={onChange} />)
    press(option('xs'), 'Tab')
    press(option('xs'), 'a')
    expect(onChange).not.toHaveBeenCalled()
  })
})
