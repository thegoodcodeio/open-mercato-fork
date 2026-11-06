"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { Switch } from '@open-mercato/ui/primitives/switch'
import type { Feature, FeatureType } from '../../../data/validators'
import { CommitValidityScope, useCommitValidity } from '../CommitInput'
import { ConditionRows } from '../ConditionRows'
import { KeySelect } from '../KeySelect'
import { friendlyName } from '../names'
import { issueMessage } from '../validationMessages'
import { FeatureOptionsEditor } from './FeatureOptionsEditor'
import { featureToForm, formToFeature, suggestOptionValue, type FeatureFormErrors, type FeatureFormValues } from './featureForm'
import { useRowEditorDirty } from './rowEditorSession'
import type { StudioDefinition, StudioIssue } from './types'

type FeatureEditorProps = {
  feature: Feature | undefined
  nextOrder: number
  definition: StudioDefinition
  otherKeys: readonly string[]
  issues: StudioIssue[]
  disabled: boolean
  onSave: (feature: Feature) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

const TYPE_LABELS: Record<FeatureType, { key: string; fallback: string }> = {
  choice: { key: 'product_configurator.studio.features.types.choice', fallback: 'Choice' },
  boolean: { key: 'product_configurator.studio.features.types.boolean', fallback: 'Yes/no' },
  number: { key: 'product_configurator.studio.features.types.number', fallback: 'Number' },
  color: { key: 'product_configurator.studio.features.types.color', fallback: 'Color' },
}
const FEATURE_TYPES: readonly FeatureType[] = ['choice', 'boolean', 'number', 'color']

const NUMBER_FIELDS = [
  { name: 'min', key: 'product_configurator.studio.features.min', fallback: 'Minimum' },
  { name: 'max', key: 'product_configurator.studio.features.max', fallback: 'Maximum' },
  { name: 'step', key: 'product_configurator.studio.features.step', fallback: 'Step' },
] as const

/** `+` is not allowed in lookup keys, so the "no lookup" item never collides with one. */
const NO_LOOKUP = '+none'

const INLINE_ERROR_FIELDS = new Set(['label', 'key', 'options', 'optionsFromLookup', 'min', 'max', 'step', 'unit', 'group', 'order', 'default'])

const ERROR_FIELD_LABELS: Record<string, { key: string; fallback: string }> = {
  type: { key: 'product_configurator.studio.features.type', fallback: 'Type' },
  inSummary: { key: 'product_configurator.studio.features.inSummary', fallback: 'In summary' },
  visibleWhen: { key: 'product_configurator.studio.features.visibleWhen', fallback: 'Shown when (all must be true)' },
}

export function FeatureEditor({ feature, nextOrder, definition, otherKeys, issues, disabled, onSave, onCancel, onDirtyChange }: FeatureEditorProps) {
  const t = useT()
  const idPrefix = React.useId()
  const [values, setValues] = React.useState<FeatureFormValues>(() => featureToForm(feature, nextOrder))
  const [errors, setErrors] = React.useState<FeatureFormErrors>({})
  const { hasInvalid, validity } = useCommitValidity()
  useRowEditorDirty(values, hasInvalid, onDirtyChange)
  const set = (patch: Partial<FeatureFormValues>) => setValues((current) => ({ ...current, ...patch }))
  const error = (field: string) => (errors[field] ? t(errors[field]) : undefined)
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const selectErrorProps = (name: string, field: string) =>
    errors[field] ? { 'aria-describedby': `${fieldId(name)}-error`, 'aria-invalid': true } : {}
  const invalidHintId = fieldId('invalid-hint')
  const hasOptions = values.type === 'choice' || values.type === 'color'
  const lookupOptions = [
    { value: NO_LOOKUP, label: t('product_configurator.studio.features.noLookup', 'None: all options are allowed') },
    ...definition.lookups
      .filter((lookup) => lookup.kind === 'permitted')
      .map((lookup) => ({ value: lookup.key, label: friendlyName(lookup.label, lookup.key) })),
  ]
  const defaultOptions = values.options
    .map((option) => ({ value: option.value.trim() ? option.value : suggestOptionValue(option.label), label: option.label || option.value }))
    .filter((option) => option.value)

  const save = () => {
    if (disabled || hasInvalid) return
    const result = formToFeature(values, otherKeys, feature)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSave(result.feature)
  }

  const changeType = (type: FeatureType) => set({ type, defaultValue: type === 'boolean' ? 'false' : '' })

  const defaultControl = () => {
    if (values.type === 'boolean' || (hasOptions && defaultOptions.length > 0)) {
      const options =
        values.type === 'boolean'
          ? [
              { value: 'true', label: t('product_configurator.studio.conditions.yes', 'Yes') },
              { value: 'false', label: t('product_configurator.studio.conditions.no', 'No') },
            ]
          : defaultOptions
      return (
        <KeySelect
          id={fieldId('default')}
          value={values.defaultValue}
          options={options}
          onChange={(defaultValue) => set({ defaultValue })}
          placeholder={t('product_configurator.studio.features.pickDefault', 'Pick the default')}
          disabled={disabled}
          {...selectErrorProps('default', 'default')}
        />
      )
    }
    return <Input value={values.defaultValue} disabled={disabled} onChange={(event) => set({ defaultValue: event.target.value })} />
  }

  const unitField = (
    <FormField id={fieldId('unit')} label={t('product_configurator.studio.features.unit', 'Unit')} error={error('unit')}>
      <Input value={values.unit} disabled={disabled} onChange={(event) => set({ unit: event.target.value })} />
    </FormField>
  )

  const otherErrors = Object.entries(errors).filter(([field]) => !INLINE_ERROR_FIELDS.has(field) && !field.startsWith('options.'))

  return (
    <CommitValidityScope value={validity}>
      <section
        className="space-y-4 rounded-lg border border-border bg-card p-4"
        data-testid="feature-editor"
        aria-label={feature ? friendlyName(feature.label, feature.key) : t('product_configurator.studio.features.newTitle', 'New feature')}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            onCancel()
          }
        }}
      >
        <h3 className="text-sm font-semibold text-foreground">
          {feature
            ? t('product_configurator.studio.features.editTitle', 'Edit feature: {name}', { name: feature.label })
            : t('product_configurator.studio.features.newTitle', 'New feature')}
        </h3>
        {issues.length > 0 ? (
          <Alert status="error">
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {issues.map((entry, index) => (
                  <li key={index}>{issueMessage(entry.issue, definition, t)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <FormField id={fieldId('label')} label={t('product_configurator.studio.features.label', 'Name')} error={error('label')}>
              <Input value={values.label} disabled={disabled} onChange={(event) => set({ label: event.target.value })} />
            </FormField>
            <FormField id={fieldId('key')} label={t('product_configurator.studio.features.key', 'Key')} error={error('key')}>
              <Input inputClassName="font-mono" value={values.key} disabled={disabled} onChange={(event) => set({ key: event.target.value })} />
            </FormField>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.features.type', 'Type')}</p>
            <SegmentedControl
              value={values.type}
              disabled={disabled}
              aria-label={t('product_configurator.studio.features.type', 'Type')}
              onValueChange={(next) => {
                const type = FEATURE_TYPES.find((entry) => entry === next)
                if (type) changeType(type)
              }}
            >
              {FEATURE_TYPES.map((type) => (
                <SegmentedControlItem key={type} value={type}>
                  {t(TYPE_LABELS[type].key, TYPE_LABELS[type].fallback)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </div>
        {hasOptions ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.features.options', 'Options')}</p>
            <FeatureOptionsEditor
              idPrefix={fieldId('options')}
              options={values.options}
              withSwatch={values.type === 'color' || values.options.some((option) => option.swatch.trim() !== '')}
              errors={errors}
              disabled={disabled}
              onChange={(options) => set({ options })}
            />
            <div className="grid gap-3 md:grid-cols-4">
              <div className="md:col-span-3">
                <FormField id={fieldId('lookup')} label={t('product_configurator.studio.features.lookup', 'Options from a permitted lookup')} error={error('optionsFromLookup')}>
                  <KeySelect
                    id={fieldId('lookup')}
                    value={values.optionsFromLookup || NO_LOOKUP}
                    options={lookupOptions}
                    onChange={(next) => set({ optionsFromLookup: next === NO_LOOKUP ? '' : next })}
                    disabled={disabled}
                    {...selectErrorProps('lookup', 'optionsFromLookup')}
                  />
                </FormField>
              </div>
              {unitField}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('product_configurator.studio.features.lookupHint', 'A permitted lookup limits the options by another feature and gives the allowed values. Options listed here give their labels.')}
            </p>
          </div>
        ) : null}
        {values.type === 'number' ? (
          <div className="grid gap-3 sm:grid-cols-4">
            {NUMBER_FIELDS.map(({ name, key, fallback }) => (
              <FormField key={name} id={fieldId(name)} label={t(key, fallback)} error={error(name)}>
                <Input value={values[name]} disabled={disabled} onChange={(event) => set({ [name]: event.target.value })} />
              </FormField>
            ))}
            {unitField}
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-4">
          <FormField id={fieldId('group')} label={t('product_configurator.studio.features.group', 'Group')} error={error('group')}>
            <Input value={values.group} disabled={disabled} onChange={(event) => set({ group: event.target.value })} />
          </FormField>
          <FormField id={fieldId('order')} label={t('product_configurator.studio.features.order', 'Order')} error={error('order')}>
            <Input inputMode="numeric" value={values.order} disabled={disabled} onChange={(event) => set({ order: event.target.value })} />
          </FormField>
          <FormField id={fieldId('default')} label={t('product_configurator.studio.features.default', 'Default')} error={error('default')}>
            {defaultControl()}
          </FormField>
          <FormField
            id={fieldId('summary')}
            label={t('product_configurator.studio.features.inSummary', 'In summary')}
            description={t('product_configurator.studio.features.inSummaryHint', 'Hidden fields never appear in the summary.')}
          >
            <Switch checked={values.inSummary} disabled={disabled} onCheckedChange={(inSummary) => set({ inSummary })} />
          </FormField>
        </div>
        <ConditionRows
          value={values.visibleWhen}
          onChange={(visibleWhen) => set({ visibleWhen })}
          definition={definition}
          excludeFeatureKey={feature?.key ?? values.key.trim()}
          disabled={disabled}
          label={t('product_configurator.studio.features.visibleWhen', 'Shown when (all must be true)')}
        />
        {otherErrors.length > 0 ? (
          <ul role="alert" className="space-y-1 text-sm text-status-error-text">
            {otherErrors.map(([field, messageKey]) => {
              const label = ERROR_FIELD_LABELS[field]
              return (
                <li key={field}>
                  {label
                    ? t('product_configurator.studio.features.errors.field', '{field}: {message}', {
                        field: t(label.key, label.fallback),
                        message: t(messageKey),
                      })
                    : t(messageKey)}
                </li>
              )
            })}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasInvalid ? (
            <p id={invalidHintId} className="text-sm text-status-error-text">
              {t('product_configurator.studio.features.fixInvalid', 'Fix the highlighted values to save the feature.')}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('ui.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={disabled || hasInvalid} aria-describedby={hasInvalid ? invalidHintId : undefined}>
            {t('product_configurator.studio.features.save', 'Save feature')}
          </Button>
        </div>
      </section>
    </CommitValidityScope>
  )
}
