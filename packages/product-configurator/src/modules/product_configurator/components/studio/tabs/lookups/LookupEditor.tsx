"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { LinkButton } from '@open-mercato/ui/primitives/link-button'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import type { Lookup } from '../../../../data/validators'
import { sortByOrder } from '../../../../lib/values'
import { featureName, friendlyName } from '../../names'
import { issueMessage } from '../../validationMessages'
import { KeySelect } from '../../KeySelect'
import { useRowEditorDirty } from '../rowEditorSession'
import type { StudioDefinition, StudioIssue } from '../types'
import {
  alignPermittedRows,
  alignValueRows,
  firstErrorRow,
  formToLookup,
  keyDomain,
  limitedFeatures,
  lookupErrorText,
  lookupToForm,
  missingMatches,
  permittedValueDomain,
  skuLineIds,
  valueRowHasValue,
  type LookupFormErrors,
  type LookupFormValues,
  type LookupKind,
} from './lookupForm'
import { PermittedRowsEditor } from './PermittedRowsEditor'
import { ValueRowsEditor } from './ValueRowsEditor'

type LookupEditorProps = {
  lookup: Lookup | undefined
  definition: StudioDefinition
  otherKeys: readonly string[]
  issues: StudioIssue[]
  disabled: boolean
  onSave: (lookup: Lookup) => void
  onCancel: () => void
  onOpenAdvanced: () => void
  onDirtyChange?: (dirty: boolean) => void
}

const KINDS: readonly LookupKind[] = ['value', 'permitted']

const KIND_LABELS: Record<LookupKind, { key: string; fallback: string }> = {
  value: { key: 'product_configurator.studio.lookups.kinds.value', fallback: 'Value' },
  permitted: { key: 'product_configurator.studio.lookups.kinds.permitted', fallback: 'Permitted options' },
}

const INLINE_ERROR_FIELDS = new Set(['label', 'key', 'keyedBy'])

/** Blank rows the editor adds for options without a row are not edits, so they are left out when looking for changes. */
function withoutPlaceholderRows(values: LookupFormValues): LookupFormValues {
  return {
    ...values,
    valueRows: values.valueRows.filter((row) => row.original !== undefined || row.text.trim() !== ''),
    permittedRows: values.permittedRows.filter((row) => row.saved || row.values.length > 0),
  }
}

export function LookupEditor({
  lookup,
  definition,
  otherKeys,
  issues,
  disabled,
  onSave,
  onCancel,
  onOpenAdvanced,
  onDirtyChange,
}: LookupEditorProps) {
  const t = useT()
  const idPrefix = React.useId()
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const [values, setValues] = React.useState<LookupFormValues>(() => lookupToForm(lookup, definition, t))
  const [errors, setErrors] = React.useState<LookupFormErrors>({})
  const [focus, setFocus] = React.useState<{ index: number } | null>(null)
  const [extraValues, setExtraValues] = React.useState<string[]>([])
  const set = (patch: Partial<LookupFormValues>) => setValues((current) => ({ ...current, ...patch }))
  const error = (field: string) => lookupErrorText(errors, field, t)
  useRowEditorDirty(values, false, onDirtyChange, withoutPlaceholderRows)

  const domain = React.useMemo(() => keyDomain(definition, values.keyedBy, t), [definition, values.keyedBy, t])
  const keyFeatureName = values.keyedBy ? featureName(definition, values.keyedBy) : ''
  const usageKey = lookup?.key ?? values.key.trim()
  const skuLines = values.kind === 'value' ? skuLineIds(definition, usageKey) : []
  const skuValues = skuLines.length > 0
  const limited = values.kind === 'permitted' ? limitedFeatures(definition, usageKey) : []
  const valueDomain = permittedValueDomain(definition, usageKey, values.permittedRows, extraValues)
  const coveredMatches =
    values.kind === 'value'
      ? values.valueRows.filter(valueRowHasValue).map((row) => row.match)
      : values.permittedRows.filter((row) => row.values.length > 0).map((row) => row.match)
  const missing = missingMatches(domain, coveredMatches)
  const features = sortByOrder(definition.features)

  const domainRef = React.useRef(domain)
  domainRef.current = domain
  const domainSignature = domain ? domain.map((option) => option.value).join('\u0000') : null
  React.useEffect(() => {
    const current = domainRef.current
    setValues((previous) => ({
      ...previous,
      valueRows: alignValueRows(previous.valueRows, current),
      permittedRows: alignPermittedRows(previous.permittedRows, current),
    }))
  }, [domainSignature])

  const save = () => {
    if (disabled) return
    const result = formToLookup(values, { definition, domain, otherKeys, skuValues })
    if (!result.ok) {
      setErrors(result.errors)
      const index = firstErrorRow(result.errors)
      if (index !== null) setFocus({ index })
      return
    }
    setErrors({})
    onSave(result.lookup)
  }

  const generalErrors = [
    ...new Set(
      Object.keys(errors)
        .filter((field) => !INLINE_ERROR_FIELDS.has(field) && !field.startsWith('rows.'))
        .map((field) => lookupErrorText(errors, field, t) ?? ''),
    ),
  ]
  const hasRowErrors = Object.keys(errors).some((field) => field.startsWith('rows.'))

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      data-testid="lookup-editor"
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
        {lookup
          ? t('product_configurator.studio.lookups.editTitle', 'Edit lookup: {name}', { name: friendlyName(lookup.label, lookup.key) })
          : t('product_configurator.studio.lookups.newTitle', 'New lookup')}
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
        <FormField
          id={fieldId('label')}
          className="min-w-0"
          label={t('product_configurator.studio.lookups.label', 'Name')}
          error={error('label')}
          description={t('product_configurator.studio.lookups.labelHint', 'Shown in the studio and in errors. The key is used when it is empty.')}
        >
          <Input value={values.label} disabled={disabled} onChange={(event) => set({ label: event.target.value })} />
        </FormField>
        <FormField id={fieldId('key')} className="min-w-0" label={t('product_configurator.studio.lookups.key', 'Key')} error={error('key')}>
          <Input className="font-mono" value={values.key} disabled={disabled} onChange={(event) => set({ key: event.target.value })} />
        </FormField>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.lookups.kind', 'Type')}</p>
          <SegmentedControl
            value={values.kind}
            disabled={disabled || lookup !== undefined}
            aria-label={t('product_configurator.studio.lookups.kind', 'Type')}
            onValueChange={(next) => {
              const kind = KINDS.find((entry) => entry === next)
              if (kind) set({ kind })
            }}
          >
            {KINDS.map((kind) => (
              <SegmentedControlItem key={kind} value={kind}>
                {t(KIND_LABELS[kind].key, KIND_LABELS[kind].fallback)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <p className="text-xs text-muted-foreground">
            {lookup
              ? t('product_configurator.studio.lookups.kindLocked', 'The type of a saved lookup changes in Advanced (JSON) only, because rules, features and BOM lines expect it.')
              : t('product_configurator.studio.lookups.kindHint', 'A value lookup maps each option to a number, text or SKU. A permitted lookup lists the allowed options and a default.')}
          </p>
        </div>
        <FormField
          id={fieldId('keyedBy')}
          className="min-w-0"
          label={t('product_configurator.studio.lookups.keyedBy', 'Keyed by')}
          error={error('keyedBy')}
          description={features.length === 0 ? t('product_configurator.studio.lookups.noFeatures', 'Add a feature first: rows are keyed by its options.') : undefined}
        >
          <KeySelect
            value={values.keyedBy}
            options={features.map((feature) => ({ value: feature.key, label: friendlyName(feature.label, feature.key) }))}
            placeholder={t('product_configurator.studio.lookups.pickFeature', 'Pick a feature')}
            disabled={disabled || features.length === 0}
            onChange={(keyedBy) => set({ keyedBy })}
          />
        </FormField>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="lookup-usage">
        {values.kind === 'value'
          ? skuValues
            ? t('product_configurator.studio.lookups.skuValues', 'Values are catalog SKUs (read by BOM line {lines}). Each SKU is checked against the catalog when you edit it.', {
                lines: skuLines.join(', '),
              })
            : t('product_configurator.studio.lookups.plainValues', 'Numbers such as 40 or 1.5 are saved as numbers. Other text, such as 007 or 1.50, is saved as typed, and formulas still read it as a number.')
          : limited.length > 0
            ? t('product_configurator.studio.lookups.limits', 'Limits the options of {features}.', {
                features: limited.map((feature) => friendlyName(feature.label, feature.key)).join(', '),
              })
            : t('product_configurator.studio.lookups.limitsNothing', 'No feature takes its options from this lookup yet.')}
      </p>
      {domain && missing.length > 0 ? (
        <Alert status="warning" data-testid="lookup-coverage">
          <AlertDescription>
            {t(
              'product_configurator.studio.lookups.coverageMissing',
              'No row for {options} of {feature}. Configurations with these options are blocked where this lookup is used, and Validate reports it.',
              { options: missing.map((option) => option.label).join(', '), feature: keyFeatureName },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {domain && domain.length > 0 && missing.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="lookup-coverage">
          {t('product_configurator.studio.lookups.coverageComplete', 'Every {feature} option has a row.', { feature: keyFeatureName })}
        </p>
      ) : null}
      {values.kind === 'value' ? (
        <ValueRowsEditor
          rows={values.valueRows}
          onChange={(valueRows) => set({ valueRows })}
          domain={domain}
          keyFeatureName={keyFeatureName}
          skuValues={skuValues}
          errors={errors}
          focus={focus}
          disabled={disabled}
        />
      ) : (
        <PermittedRowsEditor
          rows={values.permittedRows}
          onChange={(permittedRows) => set({ permittedRows })}
          domain={domain}
          keyFeatureName={keyFeatureName}
          valueDomain={valueDomain}
          canAddValues={limited.every((feature) => !feature.options || feature.options.length === 0)}
          onAddValue={(value) => setExtraValues((current) => [...current, value])}
          errors={errors}
          focus={focus}
          disabled={disabled}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {t('product_configurator.studio.lookups.bulkHint', 'Large tables (up to 1000 rows): edit here, or use Advanced (JSON) for bulk changes. Both are validated the same way.')}
        </span>
        <LinkButton size="sm" onClick={onOpenAdvanced}>
          {t('product_configurator.studio.lookups.openAdvanced', 'Open Advanced (JSON)')}
        </LinkButton>
      </div>
      {hasRowErrors || generalErrors.length > 0 ? (
        <div className="space-y-1" role="alert">
          {hasRowErrors ? <p className="text-sm text-status-error-text">{t('product_configurator.studio.lookups.fixRows', 'Fix the marked rows.')}</p> : null}
          {generalErrors.map((message) => (
            <p key={message} className="text-sm text-status-error-text">
              {message}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('ui.actions.cancel', 'Cancel')}
        </Button>
        <Button type="button" onClick={save} disabled={disabled}>
          {t('product_configurator.studio.lookups.save', 'Save lookup')}
        </Button>
      </div>
    </section>
  )
}
