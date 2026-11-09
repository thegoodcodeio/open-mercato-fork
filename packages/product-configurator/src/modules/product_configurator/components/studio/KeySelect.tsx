"use client"

import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, type SelectTriggerProps } from '@open-mercato/ui/primitives/select'

export type KeySelectOption = { value: string; label: string }

export type KeySelectProps = {
  value: string
  options: readonly KeySelectOption[]
  onChange: (value: string) => void
  id?: string
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  size?: SelectTriggerProps['size']
  className?: string
  /** Set by a wrapping `FormField`; forwarded to the trigger, which is the focusable control. */
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

/** A select that still shows a value missing from its options (e.g. a key deleted elsewhere), so nothing changes silently. */
export function KeySelect({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  placeholder,
  disabled,
  invalid,
  size,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
}: KeySelectProps) {
  const items = value === '' || options.some((option) => option.value === value) ? options : [{ value, label: value }, ...options]
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        className={className}
        aria-label={ariaLabel}
        aria-invalid={invalid || ariaInvalid || undefined}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
