"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import type { Formula } from '../../../../data/validators'
import { numericExpressionReferences, parseExpression, type ExpressionReference } from '../../../../lib/exprParse'
import { issueMessage } from '../../validationMessages'
import { useRowEditorDirty } from '../rowEditorSession'
import type { StudioDefinition, StudioIssue } from '../types'
import { ExpressionInput } from './ExpressionInput'
import {
  FORMULA_DECIMAL_CHOICES,
  FORMULA_ERROR_FALLBACKS,
  formatPreview,
  formToFormula,
  formulaReferenceKeys,
  formulaToForm,
  previewCandidate,
  type FormulaFormErrors,
  type FormulaFormValues,
} from './formulaForm'

type FormulaEditorProps = {
  formula: Formula | undefined
  definition: StudioDefinition
  otherKeys: readonly string[]
  issues: StudioIssue[]
  disabled: boolean
  onSave: (formula: Formula) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

/** `+` is not a digit, so the "not set" item never collides with a decimals value. */
const NO_DECIMALS = '+none'

/** Key used to preview a formula whose key is still empty; `+` is not allowed in keys. */
const PREVIEW_KEY = '+preview'

type TranslateFn = ReturnType<typeof useT>

function referenceDetail(definition: StudioDefinition, reference: ExpressionReference, t: TranslateFn): string {
  if (reference.namespace === 'lookup') return t('product_configurator.studio.formulas.kinds.lookup', 'lookup')
  const isFeature = reference.namespace === 'feature'
  const kind = isFeature
    ? t('product_configurator.studio.formulas.kinds.feature', 'feature')
    : t('product_configurator.studio.formulas.kinds.formula', 'formula')
  const unit = isFeature
    ? definition.features.find((entry) => entry.key === reference.key)?.unit
    : definition.formulas.find((entry) => entry.key === reference.key)?.unit
  return unit ? t('product_configurator.studio.formulas.kindWithUnit', '{kind}, {unit}', { kind, unit }) : kind
}

export function FormulaEditor({ formula, definition, otherKeys, issues, disabled, onSave, onCancel, onDirtyChange }: FormulaEditorProps) {
  const t = useT()
  const idPrefix = React.useId()
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const [values, setValues] = React.useState<FormulaFormValues>(() => formulaToForm(formula))
  const [errors, setErrors] = React.useState<FormulaFormErrors>({})
  const [saveTried, setSaveTried] = React.useState(false)
  const set = (patch: Partial<FormulaFormValues>) => setValues((current) => ({ ...current, ...patch }))
  useRowEditorDirty(values, false, onDirtyChange)

  const references = React.useMemo(
    () => numericExpressionReferences(definition, { excludeFormulaKey: formula?.key }),
    [definition, formula?.key],
  )
  const referenceKeys = React.useMemo(() => formulaReferenceKeys(definition, formula?.key), [definition, formula?.key])
  const parsed = React.useMemo(() => parseExpression(values.expression, { references: referenceKeys }), [referenceKeys, values.expression])
  const decimals = values.decimals === '' ? undefined : Number(values.decimals)
  const unit = values.unit.trim() || undefined

  const preview = React.useMemo(() => {
    if (!parsed.ok) return null
    const candidate: Formula = {
      key: values.key.trim() || formula?.key || PREVIEW_KEY,
      expr: parsed.expression,
      ...(decimals !== undefined ? { decimals } : {}),
    }
    return previewCandidate(definition, candidate, formula?.key)
  }, [decimals, definition, formula?.key, parsed, values.key])

  const save = () => {
    if (disabled) return
    setSaveTried(true)
    const result = formToFormula(values, otherKeys, referenceKeys)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSave(result.formula)
  }

  const error = (field: keyof FormulaFormErrors) => {
    const messageKey = errors[field]
    return messageKey ? t(messageKey, FORMULA_ERROR_FALLBACKS[messageKey]) : undefined
  }

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      data-testid="formula-editor"
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
        {formula
          ? t('product_configurator.studio.formulas.editTitle', 'Edit formula: {name}', { name: formula.label ?? formula.key })
          : t('product_configurator.studio.formulas.newTitle', 'New formula')}
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
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label={t('product_configurator.studio.formulas.label', 'Name')}>
          <Input value={values.label} disabled={disabled} onChange={(event) => set({ label: event.target.value })} />
        </FormField>
        <FormField label={t('product_configurator.studio.formulas.key', 'Key')} error={error('key')}>
          <Input inputClassName="font-mono" value={values.key} disabled={disabled} onChange={(event) => set({ key: event.target.value })} />
        </FormField>
      </div>
      <div className="space-y-1">
        <Label htmlFor={fieldId('expression')}>{t('product_configurator.studio.formulas.expression', 'Expression')}</Label>
        <ExpressionInput
          id={fieldId('expression')}
          value={values.expression}
          onChange={(expression) => set({ expression })}
          references={references}
          error={parsed.ok ? null : parsed.error}
          showError={saveTried || values.expression.trim() !== ''}
          describeReference={(reference) => referenceDetail(definition, reference, t)}
          hintId={fieldId('expression-hint')}
          disabled={disabled}
        />
        <p id={fieldId('expression-hint')} className="text-xs text-muted-foreground">
          {t('product_configurator.studio.formulas.syntaxHint', 'Use feature.key, formula.key, lookup.key, numbers and + - * /. Start typing a name to pick a reference.')}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label={t('product_configurator.studio.formulas.unit', 'Unit')}>
          <Input value={values.unit} disabled={disabled} onChange={(event) => set({ unit: event.target.value })} />
        </FormField>
        <FormField id={fieldId('decimals')} label={t('product_configurator.studio.formulas.decimals', 'Decimals')} error={error('decimals')}>
          <Select
            value={values.decimals === '' ? NO_DECIMALS : values.decimals}
            onValueChange={(next) => set({ decimals: next === NO_DECIMALS ? '' : next })}
            disabled={disabled}
          >
            <SelectTrigger
              id={fieldId('decimals')}
              aria-invalid={errors.decimals ? true : undefined}
              aria-describedby={errors.decimals ? `${fieldId('decimals')}-error` : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DECIMALS}>{t('product_configurator.studio.formulas.decimalsUnset', 'Not set (up to 6)')}</SelectItem>
              {FORMULA_DECIMAL_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {choice}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.formulas.preview', 'Preview')}</p>
          <p className="flex h-9 items-center font-mono text-sm text-foreground" data-testid="formula-editor-preview">
            {formatPreview(preview, decimals, unit)}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('product_configurator.studio.formulas.previewHint', 'Previews use the model defaults. "—" means the value cannot be computed with them.')}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('ui.actions.cancel', 'Cancel')}
        </Button>
        <Button type="button" onClick={save} disabled={disabled}>
          {t('product_configurator.studio.formulas.save', 'Save formula')}
        </Button>
      </div>
    </section>
  )
}
