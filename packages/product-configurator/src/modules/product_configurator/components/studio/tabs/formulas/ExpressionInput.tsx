"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Input } from '@open-mercato/ui/primitives/input'
import { LinkButton } from '@open-mercato/ui/primitives/link-button'
import {
  applyExpressionEdit,
  closeMatchForError,
  suggestExpressionReferences,
  type ExpressionEdit,
  type ExpressionParseError,
  type ExpressionReference,
} from '../../../../lib/exprParse'
import { friendlyName } from '../../names'
import { expressionErrorMessage } from './expressionMessages'

type ExpressionInputProps = {
  id: string
  value: string
  onChange: (text: string) => void
  /** Numeric references offered by the autocomplete and the "Use it" fix. */
  references: readonly ExpressionReference[]
  /** Parse error of `value`; shown only when `showError` is set. */
  error: ExpressionParseError | null
  showError: boolean
  describeReference: (reference: ExpressionReference) => string
  hintId?: string
  disabled?: boolean
}

/**
 * Text input for a formula expression with combobox autocomplete (ARIA 1.2 pattern, focus stays
 * in the input): suggestions follow the word at the cursor, arrows move, Enter picks, Escape closes.
 */
export function ExpressionInput({
  id,
  value,
  onChange,
  references,
  error,
  showError,
  describeReference,
  hintId,
  disabled,
}: ExpressionInputProps) {
  const t = useT()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const pendingCursor = React.useRef<number | null>(null)
  const listboxId = `${id}-suggestions`
  const errorId = `${id}-error`
  const [cursor, setCursor] = React.useState(value.length)
  const [focused, setFocused] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)

  const suggestions = React.useMemo(() => suggestExpressionReferences(value, cursor, references), [cursor, references, value])
  const open = focused && !dismissed && !disabled && suggestions.length > 0
  const active = open ? Math.min(activeIndex, suggestions.length - 1) : -1
  const visibleError = showError ? error : null
  const fix = visibleError ? closeMatchForError(visibleError, references) : null

  React.useLayoutEffect(() => {
    if (pendingCursor.current === null) return
    inputRef.current?.setSelectionRange(pendingCursor.current, pendingCursor.current)
    pendingCursor.current = null
  })

  const applyEdit = (edit: ExpressionEdit) => {
    const next = applyExpressionEdit(value, edit)
    pendingCursor.current = next.cursor
    setCursor(next.cursor)
    setDismissed(true)
    onChange(next.text)
    inputRef.current?.focus()
  }

  const readCursor = (input: HTMLInputElement) => setCursor(input.selectionStart ?? input.value.length)

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        event.preventDefault()
        setDismissed(false)
        setActiveIndex(0)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((active + 1) % suggestions.length)
        return
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((active - 1 + suggestions.length) % suggestions.length)
        return
      case 'Enter':
        if (event.metaKey || event.ctrlKey) return
        event.preventDefault()
        applyEdit(suggestions[active])
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        setDismissed(true)
        return
      case 'Tab':
        setDismissed(true)
    }
  }

  const describedBy = [visibleError ? errorId : null, hintId ?? null].filter(Boolean).join(' ') || undefined

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          inputClassName="font-mono"
          value={value}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listboxId}-${active}` : undefined}
          aria-invalid={visibleError ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            readCursor(event.target)
            setDismissed(false)
            setActiveIndex(0)
            onChange(event.target.value)
          }}
          onSelect={(event) => readCursor(event.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t('product_configurator.studio.formulas.suggestions', 'Suggestions')}
            className="absolute inset-x-0 top-full z-dropdown mt-1 max-h-60 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.insertText}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`flex cursor-pointer flex-wrap items-baseline gap-x-2 rounded-sm px-2 py-1.5 text-sm ${index === active ? 'bg-muted' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => applyEdit(suggestion)}
              >
                <span className="font-medium text-foreground">{suggestion.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{suggestion.insertText}</span>
                <span className="text-xs text-muted-foreground">{describeReference(suggestion)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {visibleError ? (
        <p id={errorId} className="text-xs text-status-error-text">
          {expressionErrorMessage(visibleError, t)}
          {fix ? (
            <>
              {' '}
              {t('product_configurator.studio.formulas.didYouMean', 'Did you mean {name}?', { name: friendlyName(fix.label, fix.key) })}{' '}
              <LinkButton size="sm" underline="always" disabled={disabled} onClick={() => applyEdit(fix)}>
                {t('product_configurator.studio.formulas.useIt', 'Use it')}
              </LinkButton>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
