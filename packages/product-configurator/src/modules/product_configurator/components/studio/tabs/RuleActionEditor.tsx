"use client"

import * as React from 'react'
import { ArrowRight, Plus, X } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { sortByOrder, toFiniteNumber } from '../../../lib/values'
import { CommitInput } from '../CommitInput'
import { featureValueOptions } from '../conditionRowsModel'
import { featureName, friendlyName } from '../names'
import { KeySelect } from '../KeySelect'
import {
  RULE_ACTION_KINDS,
  RULE_ERROR_FALLBACKS,
  mappableFeatures,
  nextMapRow,
  permittedLookup,
  withActionFeature,
  withActionKind,
  type MapRow,
  type RuleActionForm,
  type RuleActionKind,
  type RuleFormErrors,
} from './ruleForm'
import type { StudioDefinition } from './types'

type RuleActionEditorProps = {
  action: RuleActionForm
  definition: StudioDefinition
  errors: RuleFormErrors
  disabled: boolean
  onChange: (action: RuleActionForm) => void
}

export const ACTION_KIND_LABELS: Record<RuleActionKind, { key: string; fallback: string }> = {
  set: { key: 'product_configurator.studio.rules.actions.set', fallback: 'Set a value' },
  map: { key: 'product_configurator.studio.rules.actions.map', fallback: 'Map values' },
  lookup_default: { key: 'product_configurator.studio.rules.actions.lookupDefault', fallback: 'Default from a permitted lookup' },
}

function FieldError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="mt-1 text-xs text-status-error-text">
      {message}
    </p>
  ) : null
}

/** The "then" part of a force rule: set a value, map values, or write the default of a permitted lookup row. */
export function RuleActionEditor({ action, definition, errors, disabled, onChange }: RuleActionEditorProps) {
  const t = useT()
  const errorText = (field: string) => (errors[field] ? t(errors[field], RULE_ERROR_FALLBACKS[errors[field]]) : undefined)
  const feature = definition.features.find((entry) => entry.key === action.featureKey)
  const fieldFeatures = action.kind === 'map' ? mappableFeatures(definition) : sortByOrder(definition.features)
  const fieldOptions = fieldFeatures.map((entry) => ({ value: entry.key, label: friendlyName(entry.label, entry.key) }))
  const valueOptions = featureValueOptions(definition, feature, t)
  const permittedLookups = definition.lookups.filter((lookup) => lookup.kind === 'permitted')
  const selectedLookup = permittedLookup(definition, action.lookupKey)
  const valueLabel = t('product_configurator.studio.rules.action.value', 'Value')

  const setValueControl = () => {
    if (valueOptions.length > 0) {
      return (
        <KeySelect
          size="sm"
          className="min-w-0 flex-1 basis-40"
          value={String(action.setValue)}
          options={valueOptions}
          disabled={disabled}
          ariaLabel={valueLabel}
          placeholder={t('product_configurator.studio.rules.action.pickValue', 'Pick a value')}
          onChange={(next) => onChange({ ...action, setValue: feature?.type === 'boolean' ? next === 'true' : next })}
        />
      )
    }
    if (feature?.type === 'number') {
      return (
        <CommitInput
          value={String(action.setValue)}
          parse={toFiniteNumber}
          error={t('product_configurator.studio.conditions.numberRequired', 'Enter a number.')}
          disabled={disabled}
          ariaLabel={valueLabel}
          onCommit={(setValue) => onChange({ ...action, setValue })}
        />
      )
    }
    return (
      <CommitInput
        value={String(action.setValue)}
        parse={(text) => text}
        error=""
        disabled={disabled}
        ariaLabel={valueLabel}
        onCommit={(setValue) => onChange({ ...action, setValue })}
      />
    )
  }

  const updateRow = (index: number, patch: Partial<MapRow>) =>
    onChange({ ...action, mapRows: action.mapRows.map((row, position) => (position === index ? { ...row, ...patch } : row)) })

  const mapEditor = () => (
    <div className="space-y-2" data-testid="rule-map-editor">
      <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground">
        <span>{t('product_configurator.studio.rules.action.currentValue', 'Current value')}</span>
        <span>{t('product_configurator.studio.rules.action.newValue', 'New value')}</span>
      </div>
      {action.mapRows.map((row, index) => (
        <div
          key={index}
          role="group"
          aria-label={t('product_configurator.studio.rules.action.mapRow', 'Row {position}', { position: index + 1 })}
          className="flex flex-wrap items-start gap-2"
          data-testid="rule-map-row"
        >
          <FormField className="min-w-0 flex-1 basis-40" error={errorText(`action.mapRows.${index}.from`)}>
            <KeySelect
              size="sm"
              value={row.from}
              options={valueOptions}
              disabled={disabled}
              className="w-full"
              ariaLabel={t('product_configurator.studio.rules.action.currentValue', 'Current value')}
              onChange={(from) => updateRow(index, { from })}
            />
          </FormField>
          <ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <FormField className="min-w-0 flex-1 basis-40" error={errorText(`action.mapRows.${index}.to`)}>
            <KeySelect
              size="sm"
              value={row.to}
              options={valueOptions}
              disabled={disabled}
              className="w-full"
              ariaLabel={t('product_configurator.studio.rules.action.newValue', 'New value')}
              onChange={(to) => updateRow(index, { to })}
            />
          </FormField>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={t('product_configurator.studio.rules.action.removeMapRow', 'Remove row {position}', { position: index + 1 })}
            onClick={() => onChange({ ...action, mapRows: action.mapRows.filter((_, position) => position !== index) })}
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
          disabled={disabled || valueOptions.length === 0}
          onClick={() => onChange({ ...action, mapRows: [...action.mapRows, nextMapRow(action.mapRows, valueOptions.map((option) => option.value))] })}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('product_configurator.studio.rules.action.addRow', 'Add row')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('product_configurator.studio.rules.action.mapHint', 'Values come from the {field} options. Values not in the table stay as they are.', {
            field: featureName(definition, action.featureKey),
          })}
        </span>
      </div>
      <FieldError message={errorText('action.mapRows')} />
    </div>
  )

  const lookupEditor = () => (
    <div className="space-y-1">
      <FormField label={t('product_configurator.studio.rules.action.lookup', 'Lookup')} error={errorText('action.lookupKey')}>
        <KeySelect
          size="sm"
          value={action.lookupKey}
          options={permittedLookups.map((entry) => ({ value: entry.key, label: friendlyName(entry.label, entry.key) }))}
          disabled={disabled}
          className="w-full"
          ariaLabel={t('product_configurator.studio.rules.action.lookup', 'Lookup')}
          placeholder={t('product_configurator.studio.rules.action.pickLookup', 'Pick a permitted lookup')}
          onChange={(lookupKey) => onChange({ ...action, lookupKey })}
        />
      </FormField>
      {selectedLookup ? (
        <p className="text-xs text-muted-foreground">
          {t('product_configurator.studio.rules.action.keyedBy', 'Keyed by {feature}. Writes the default of the row that matches it; no row, no change.', {
            feature: featureName(definition, selectedLookup.keyedBy),
          })}
        </p>
      ) : null}
      {permittedLookups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('product_configurator.studio.rules.action.noPermittedLookups', 'Add a permitted lookup in the Lookups tab first.')}
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="rule-action-editor">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.rules.action.kind', 'Then')}</p>
        <SegmentedControl
          value={action.kind}
          disabled={disabled}
          aria-label={t('product_configurator.studio.rules.action.kind', 'Then')}
          onValueChange={(next) => {
            const kind = RULE_ACTION_KINDS.find((entry) => entry === next)
            if (kind) onChange(withActionKind(action, kind, definition))
          }}
        >
          {RULE_ACTION_KINDS.map((kind) => (
            <SegmentedControlItem key={kind} value={kind}>
              {t(ACTION_KIND_LABELS[kind].key, ACTION_KIND_LABELS[kind].fallback)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label={t('product_configurator.studio.rules.action.field', 'Field to change')} error={errorText('action.featureKey')}>
          <KeySelect
            size="sm"
            value={action.featureKey}
            options={fieldOptions}
            disabled={disabled}
            className="w-full"
            ariaLabel={t('product_configurator.studio.rules.action.field', 'Field to change')}
            placeholder={t('product_configurator.studio.rules.action.pickField', 'Pick a field')}
            onChange={(featureKey) => onChange(withActionFeature(action, featureKey, definition))}
          />
        </FormField>
        {action.kind === 'set' ? (
          <FormField label={valueLabel} error={errorText('action.setValue')}>
            {setValueControl()}
          </FormField>
        ) : null}
        {action.kind === 'lookup_default' ? lookupEditor() : null}
      </div>
      {action.kind === 'map' ? mapEditor() : null}
    </div>
  )
}
