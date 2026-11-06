"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Input } from '@open-mercato/ui/primitives/input'
import type { Feature } from '../../data/validators'
import { checkNumberInput, type NumberInputCheck } from './workspaceModel'

const COMMIT_DELAY_MS = 400

type NumberFeatureFieldProps = {
  feature: Feature
  id: string
  value: number | null
  disabled: boolean
  describedBy?: string
  serverError: string | null
  /** A new value drops the text being typed and its pending commit, even when the value stayed the same. */
  resetGeneration: number
  onCommit: (value: number) => void
  onInvalidChange: (invalid: boolean) => void
}

/**
 * Keeps its own text while typing and sends only a valid number, on Enter, on blur or after a short pause.
 * Range and step errors show under the field. Its text, its pending commit and its invalid flag are dropped when
 * a value is set from outside (a rule, a reviewed conflict, also one keeping the same value), on a lock by a rule,
 * and when the field leaves the form.
 */
export function NumberFeatureField({ feature, id, value, disabled, describedBy, serverError, resetGeneration, onCommit, onInvalidChange }: NumberFeatureFieldProps) {
  const t = useT()
  const locale = useLocale()
  const [text, setText] = React.useState(value === null ? '' : String(value))
  const [check, setCheck] = React.useState<NumberInputCheck | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const committedRef = React.useRef(value)
  const resetGenerationRef = React.useRef(resetGeneration)
  const invalidChangeRef = React.useRef(onInvalidChange)
  invalidChangeRef.current = onInvalidChange

  const showCommitted = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    const committed = committedRef.current
    setText(committed === null ? '' : String(committed))
    setCheck(null)
    invalidChangeRef.current(false)
  }, [])

  React.useEffect(() => {
    const reset = resetGeneration !== resetGenerationRef.current
    resetGenerationRef.current = resetGeneration
    if (!reset && value === committedRef.current) return
    committedRef.current = value
    showCommitted()
  }, [value, resetGeneration, showCommitted])

  React.useEffect(() => {
    if (disabled) showCommitted()
  }, [disabled, showCommitted])

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      invalidChangeRef.current(false)
    },
    [],
  )

  const commit = React.useCallback(
    (result: NumberInputCheck) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      if (!result.ok || result.value === committedRef.current) return
      committedRef.current = result.value
      onCommit(result.value)
    },
    [onCommit],
  )

  const onChange = (next: string) => {
    setText(next)
    const result = checkNumberInput(feature, next)
    setCheck(result)
    onInvalidChange(!result.ok)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = result.ok ? setTimeout(() => commit(result), COMMIT_DELAY_MS) : null
  }

  const format = (input: number | undefined) => (input === undefined ? '' : new Intl.NumberFormat(locale).format(input))
  const range = { min: format(feature.min), max: format(feature.max), step: format(feature.step) }
  const localError = check && !check.ok
    ? {
        type: t('product_configurator.configurator.number.type', 'Enter a number.'),
        below_min: t('product_configurator.configurator.number.belowMin', 'Use {min} or more.', range),
        above_max: t('product_configurator.configurator.number.aboveMax', 'Use {max} or less.', range),
        step: t('product_configurator.configurator.number.step', 'Use steps of {step}, starting from {base}.', { ...range, base: format(feature.min ?? 0) }),
      }[check.reason]
    : null
  const error = localError ?? serverError
  const hintParts = [
    feature.min !== undefined && feature.max !== undefined
      ? t('product_configurator.configurator.number.range', '{min} to {max}', range)
      : null,
    feature.step !== undefined ? t('product_configurator.configurator.number.stepHint', 'step {step}', range) : null,
  ].filter((part): part is string => part !== null)
  const messageId = `${id}-message`

  return (
    <div className="space-y-1">
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy, error || hintParts.length ? messageId : null].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => commit(checkNumberInput(feature, text))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(checkNumberInput(feature, text))
          }
        }}
      />
      {error ? (
        <p id={messageId} className="text-xs text-status-error-text">
          {error}
        </p>
      ) : hintParts.length ? (
        <p id={messageId} className="text-xs text-muted-foreground">
          {hintParts.join(', ')}
        </p>
      ) : null}
    </div>
  )
}
