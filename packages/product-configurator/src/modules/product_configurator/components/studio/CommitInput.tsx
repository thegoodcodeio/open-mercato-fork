"use client"

import * as React from 'react'
import { Input } from '@open-mercato/ui/primitives/input'

type CommitValidity = { report: (inputId: string, valid: boolean) => void }

const CommitValidityContext = React.createContext<CommitValidity | null>(null)

/** Provided by a row editor so it can block Save while any nested `CommitInput` holds text that does not parse. */
export const CommitValidityScope = CommitValidityContext.Provider

/** Tracks the `CommitInput`s inside a `CommitValidityScope` that currently hold invalid text. */
export function useCommitValidity(): { hasInvalid: boolean; validity: CommitValidity } {
  const [invalidIds, setInvalidIds] = React.useState<ReadonlySet<string>>(() => new Set())
  const report = React.useCallback((inputId: string, valid: boolean) => {
    setInvalidIds((current) => {
      if (current.has(inputId) !== valid) return current
      const next = new Set(current)
      if (valid) next.delete(inputId)
      else next.add(inputId)
      return next
    })
  }, [])
  const validity = React.useMemo(() => ({ report }), [report])
  return { hasInvalid: invalidIds.size > 0, validity }
}

type CommitInputProps<Value> = {
  value: string
  /** Returns the committed value, or `null` while the text is not valid yet. */
  parse: (text: string) => Value | null
  onCommit: (value: Value) => void
  /** Shown under the field while the text does not parse; empty hides it. */
  error: string
  ariaLabel: string
  id?: string
  /** Set by a wrapping `FormField` for an error that does not come from parsing. */
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  disabled?: boolean
  className?: string
}

/**
 * Keeps the typed text locally and commits only values that parse, so the draft never holds a
 * half-typed number. The text follows `value` again when it changes from outside (a committed
 * "1.0" stays as typed, because it parses to the same value as the "1" it produced). While the
 * text does not parse, the enclosing `CommitValidityScope` is told, so its editor cannot save the
 * last valid value silently.
 */
export function CommitInput<Value>({
  value,
  parse,
  onCommit,
  error,
  ariaLabel,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  disabled,
  className,
}: CommitInputProps<Value>) {
  const [text, setText] = React.useState(value)
  const [invalid, setInvalid] = React.useState(() => parse(value) === null)
  const inputId = React.useId()
  const validity = React.useContext(CommitValidityContext)
  const parseRef = React.useRef(parse)
  parseRef.current = parse

  const textRef = React.useRef(text)
  textRef.current = text

  React.useEffect(() => {
    const typed = parseRef.current(textRef.current)
    if (typed !== null && Object.is(typed, parseRef.current(value))) return
    setText(value)
    setInvalid(parseRef.current(value) === null)
  }, [value])

  React.useEffect(() => {
    if (!validity || !invalid) return
    validity.report(inputId, false)
    return () => validity.report(inputId, true)
  }, [validity, inputId, invalid])

  const errorId = invalid && error ? `${inputId}-error` : null
  const ariaDescribedBy = [errorId, describedBy].filter(Boolean).join(' ') || undefined

  return (
    <div className={className ?? 'min-w-0 flex-1 basis-28'}>
      <Input
        id={id}
        size="sm"
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const parsed = parse(next)
          setInvalid(parsed === null)
          if (parsed !== null) onCommit(parsed)
        }}
      />
      {errorId ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-status-error-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}
