"use client"

import * as React from 'react'
import { Plus, X } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { suggestOptionValue, type FeatureFormErrors, type FeatureFormOption } from './featureForm'

type FeatureOptionsEditorProps = {
  idPrefix: string
  options: FeatureFormOption[]
  withSwatch: boolean
  errors: FeatureFormErrors
  disabled: boolean
  onChange: (options: FeatureFormOption[]) => void
}

const SWATCH_PATTERN = /^#[0-9A-Fa-f]{6}$/

export function FeatureOptionsEditor({ idPrefix, options, withSwatch, errors, disabled, onChange }: FeatureOptionsEditorProps) {
  const t = useT()
  const errorText = (field: string) => (errors[field] ? t(errors[field]) : undefined)
  const update = (index: number, patch: Partial<FeatureFormOption>) =>
    onChange(options.map((option, position) => (position === index ? { ...option, ...patch } : option)))
  const nextOrder = options.reduce((highest, option) => Math.max(highest, Number(option.order) || 0), 0) + 1
  const fieldId = (index: number, name: string) => `${idPrefix}-${index}-${name}`
  const listErrorId = `${idPrefix}-error`

  return (
    <div className="space-y-2" data-testid="feature-options-editor">
      {options.map((option, index) => (
        <div
          key={index}
          role="group"
          aria-label={t('product_configurator.studio.features.optionRow', 'Option {position}', { position: index + 1 })}
          className="flex flex-wrap items-start gap-2"
          data-testid="feature-option-row"
        >
          <FormField id={fieldId(index, 'label')} className="min-w-0 flex-1 basis-40" error={errorText(`options.${index}.label`)}>
            <Input
              size="sm"
              value={option.label}
              disabled={disabled}
              aria-label={t('product_configurator.studio.features.optionLabel', 'Option')}
              onChange={(event) => update(index, { label: event.target.value })}
              onBlur={() => (option.value.trim() ? undefined : update(index, { value: suggestOptionValue(option.label) }))}
            />
          </FormField>
          <FormField id={fieldId(index, 'value')} className="min-w-0 flex-1 basis-32" error={errorText(`options.${index}.value`)}>
            <Input
              size="sm"
              inputClassName="font-mono"
              value={option.value}
              disabled={disabled}
              aria-label={t('product_configurator.studio.features.optionValue', 'Value')}
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </FormField>
          {withSwatch ? (
            <FormField id={fieldId(index, 'swatch')} className="min-w-0 basis-32" error={errorText(`options.${index}.swatch`)}>
              <Input
                size="sm"
                inputClassName="font-mono"
                value={option.swatch}
                placeholder={t('product_configurator.studio.features.swatchPlaceholder', '#RRGGBB')}
                disabled={disabled}
                aria-label={t('product_configurator.studio.features.optionSwatch', 'Swatch')}
                leading={
                  SWATCH_PATTERN.test(option.swatch) ? (
                    <span className="size-4 rounded-sm border border-border" style={{ backgroundColor: option.swatch }} aria-hidden="true" />
                  ) : null
                }
                onChange={(event) => update(index, { swatch: event.target.value })}
              />
            </FormField>
          ) : null}
          <FormField id={fieldId(index, 'order')} className="w-20" error={errorText(`options.${index}.order`)}>
            <Input
              size="sm"
              inputMode="numeric"
              value={option.order}
              disabled={disabled}
              aria-label={t('product_configurator.studio.features.optionOrder', 'Order')}
              onChange={(event) => update(index, { order: event.target.value })}
            />
          </FormField>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={t('product_configurator.studio.features.removeOption', 'Remove option')}
            onClick={() => onChange(options.filter((_, position) => position !== index))}
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-describedby={errors.options ? listErrorId : undefined}
          onClick={() => onChange([...options, { label: '', value: '', swatch: '', order: String(nextOrder) }])}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('product_configurator.studio.features.addOption', 'Add option')}
        </Button>
        {withSwatch ? (
          <span className="text-xs text-muted-foreground">
            {t('product_configurator.studio.features.swatchHint', 'Swatches must be #RRGGBB.')}
          </span>
        ) : null}
      </div>
      {errors.options ? (
        <p id={listErrorId} role="alert" className="text-xs text-status-error-text">
          {errorText('options')}
        </p>
      ) : null}
    </div>
  )
}
