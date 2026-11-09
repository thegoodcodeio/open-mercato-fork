"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { Switch } from '@open-mercato/ui/primitives/switch'
import type { ConfigurationDefinition, Feature, SelectionValue } from '../../data/validators'
import { NumberFeatureField } from './NumberFeatureField'
import { featureFieldId, featureOptions, type FeatureOption } from './workspaceModel'

/** Up to this many options a choice is a radio group; more become a select. */
const MAX_RADIO_OPTIONS = 5

const ARROW_STEPS: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

export type FeatureFieldProps = {
  definition: ConfigurationDefinition
  feature: Feature
  value: SelectionValue | null
  /** Values the current choices allow (`null`: all options). */
  allowedValues: string[] | null
  /** Label of the rule that set this value, when a rule set it. */
  forcedBy: string | null
  serverError: string | null
  highlighted: boolean
  /** `resetGeneration` of the evaluation state; a new one drops text being typed in a number field. */
  resetGeneration: number
  onChange: (value: SelectionValue) => void
  onInvalidChange: (invalid: boolean) => void
}

export function FeatureField({ definition, feature, value, allowedValues, forcedBy, serverError, highlighted, resetGeneration, onChange, onInvalidChange }: FeatureFieldProps) {
  const t = useT()
  const id = featureFieldId(feature.key)
  const labelId = `${id}-label`
  const reasonId = `${id}-reason`
  const forcedId = `${id}-forced`
  const errorId = `${id}-error`
  const describedBy = [forcedBy ? forcedId : null, serverError ? errorId : null].filter(Boolean).join(' ') || undefined
  const invalid = serverError ? true : undefined
  const current = value === null ? '' : String(value)
  const chosenRef = React.useRef(current)
  chosenRef.current = current
  const lockedReason = forcedBy
    ? t('product_configurator.configurator.forced.locked', 'Set automatically by {reason}.', { reason: forcedBy })
    : null
  const unavailableReason = t('product_configurator.configurator.option.unavailable', 'Not available with the current choices.')

  const optionState = (option: FeatureOption) => {
    if (option.value === current) return { blocked: false, reasonId: undefined }
    if (forcedBy) return { blocked: true, reasonId: forcedId }
    if (allowedValues && !allowedValues.includes(option.value)) return { blocked: true, reasonId }
    return { blocked: false, reasonId: undefined }
  }

  const renderRadios = (options: FeatureOption[], swatches: boolean) => {
    const blocked = options.filter((option) => optionState(option).blocked && !forcedBy)
    const choose = (option: FeatureOption) => {
      if (optionState(option).blocked || option.value === chosenRef.current) return
      chosenRef.current = option.value
      onChange(option.value)
    }
    // Radix moves focus in a timeout and checks the item only while the arrow key is still down, so a quick
    // press moved focus without choosing. Arrows choose the next available option here, like native radios.
    const onArrowKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const step = ARROW_STEPS[event.key]
      if (!step) return
      event.preventDefault()
      for (let offset = 1; offset < options.length; offset += 1) {
        const target = (index + step * offset + options.length) % options.length
        if (optionState(options[target]).blocked) continue
        choose(options[target])
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
        return
      }
    }
    return (
      <>
        <SegmentedControl
          id={id}
          value={current}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className="h-auto flex-wrap"
          onValueChange={(next) => {
            const option = options.find((entry) => entry.value === next)
            if (option) choose(option)
          }}
        >
          {options.map((option, index) => {
            const state = optionState(option)
            return (
              <SegmentedControlItem
                key={option.value}
                value={option.value}
                onKeyDown={(event) => onArrowKey(event, index)}
                aria-disabled={state.blocked || undefined}
                aria-describedby={state.reasonId}
                className={cn(state.blocked && 'text-muted-foreground line-through opacity-60')}
                data-testid={`configurator-option-${feature.key}-${option.value}`}
              >
                {swatches && option.swatch ? (
                  <span aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-full border border-border" style={{ backgroundColor: option.swatch }} />
                ) : null}
                {option.label}
              </SegmentedControlItem>
            )
          })}
        </SegmentedControl>
        {blocked.length > 0 ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {blocked.map((option) => option.label).join(', ')}: {unavailableReason}
          </p>
        ) : null}
      </>
    )
  }

  const renderControl = () => {
    if (feature.type === 'boolean') {
      return (
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            checked={value === true}
            disabled={forcedBy !== null}
            onCheckedChange={(checked) => onChange(checked)}
          />
          <span className="text-sm">
            {value === true ? t('product_configurator.configurator.values.yes', 'Yes') : t('product_configurator.configurator.values.no', 'No')}
          </span>
        </div>
      )
    }
    if (feature.type === 'number') {
      return (
        <NumberFeatureField
          feature={feature}
          id={id}
          value={typeof value === 'number' ? value : null}
          disabled={forcedBy !== null}
          describedBy={forcedBy ? forcedId : undefined}
          serverError={serverError}
          resetGeneration={resetGeneration}
          onCommit={onChange}
          onInvalidChange={onInvalidChange}
        />
      )
    }
    const options = featureOptions(definition, feature)
    if (feature.type === 'color' || options.length <= MAX_RADIO_OPTIONS) return renderRadios(options, feature.type === 'color')
    return (
      <Select
        value={current}
        onValueChange={(next) => {
          const option = options.find((entry) => entry.value === next)
          if (option && !optionState(option).blocked) onChange(option.value)
        }}
      >
        <SelectTrigger id={id} aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={invalid}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const state = optionState(option)
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                aria-disabled={state.blocked || undefined}
                className={cn(state.blocked && 'text-muted-foreground')}
                data-testid={`configurator-option-${feature.key}-${option.value}`}
              >
                {state.blocked ? `${option.label} (${forcedBy ? lockedReason : unavailableReason})` : option.label}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    )
  }

  return (
    <div
      id={`${id}-field`}
      className={cn('space-y-1.5 rounded-md p-1 transition-shadow', highlighted && 'shadow-focus', forcedBy && 'border-l-2 border-border pl-3')}
      data-testid={`configurator-feature-${feature.key}`}
    >
      <label id={labelId} htmlFor={id} className="block text-sm font-medium">
        {feature.unit && feature.type === 'number' ? `${feature.label} (${feature.unit})` : feature.label}
      </label>
      {renderControl()}
      {lockedReason ? (
        <p id={forcedId} className="text-xs text-muted-foreground">
          {lockedReason}
        </p>
      ) : null}
      {serverError && feature.type !== 'number' ? (
        <p id={errorId} className="text-xs text-status-error-text">
          {serverError}
        </p>
      ) : null}
    </div>
  )
}
