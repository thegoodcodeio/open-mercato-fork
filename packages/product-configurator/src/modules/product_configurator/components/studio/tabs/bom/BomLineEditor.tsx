"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import type { BomLineDefinition } from '../../../../data/validators'
import { sortByOrder } from '../../../../lib/values'
import { CommitValidityScope, useCommitValidity } from '../../CommitInput'
import { ConditionRows } from '../../ConditionRows'
import { friendlyName, lookupName, ruleName } from '../../names'
import { issueMessage } from '../../validationMessages'
import { useRowEditorDirty } from '../rowEditorSession'
import type { StudioDefinition, StudioIssue } from '../types'
import { summarizeSkuUnits, useCatalogItems, type CatalogCache } from './bomCatalog'
import { formToLine, lineSkus, lineToForm, samePart, skuLookups, type BomFormErrors, type BomFormValues, type BomQuantityKind } from './bomForm'
import { BomPartFields } from './BomPartFields'
import { BomUnitField } from './BomUnitField'
import { unitList, unitProblems } from './bomUnitMessages'
import { KeySelect } from '../../KeySelect'

type BomLineEditorProps = {
  line: BomLineDefinition | undefined
  defaults: { id: string; order: number }
  definition: StudioDefinition
  otherIds: readonly string[]
  catalogCache: CatalogCache
  issues: StudioIssue[]
  disabled: boolean
  onSave: (line: BomLineDefinition) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

const SKU_CHECK_DELAY_MS = 300

/** `+` is not allowed in ids, so the "no rule" item never collides with a rule. */
const NO_RULE = '+none'

const QUANTITY_KINDS: readonly BomQuantityKind[] = ['number', 'formula']

const INLINE_ERROR_FIELDS = new Set(['id', 'sku', 'lookupKey', 'quantity', 'formulaKey', 'order', 'unit', 'ruleId'])

function useDebouncedText(value: string, delayMs: number): string {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs, value])
  return debounced
}

export function BomLineEditor({
  line,
  defaults,
  definition,
  otherIds,
  catalogCache,
  issues,
  disabled,
  onSave,
  onCancel,
  onDirtyChange,
}: BomLineEditorProps) {
  const t = useT()
  const idPrefix = React.useId()
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const [values, setValues] = React.useState<BomFormValues>(() => lineToForm(line, defaults))
  const [errors, setErrors] = React.useState<BomFormErrors>({})
  const { hasInvalid, validity } = useCommitValidity()
  useRowEditorDirty(values, hasInvalid, onDirtyChange)
  const invalidHintId = fieldId('invalid-hint')
  const set = (patch: Partial<BomFormValues>) => setValues((current) => ({ ...current, ...patch }))
  const error = (field: string) => (errors[field] ? t(errors[field]) : undefined)

  const typedSku = values.sku.trim()
  const checkedSku = useDebouncedText(typedSku, SKU_CHECK_DELAY_MS)
  const lookup = skuLookups(definition).find((entry) => entry.key === values.lookupKey)
  const skus = values.partKind === 'sku' ? (checkedSku ? [checkedSku] : []) : lineSkus(values, definition)
  const catalog = useCatalogItems(skus, catalogCache)
  const summary = summarizeSkuUnits(skus, catalog.entries)
  const checking = skus.length > 0 && (catalog.pending || summary.checking || (values.partKind === 'sku' && checkedSku !== typedSku))
  const keptUom = samePart(values, line) ? (line?.uom ?? null) : null
  const uom = checking ? null : (summary.commonUnit ?? keptUom)
  const problems = checking ? [] : unitProblems(summary, lookup ? lookupName(definition, lookup.key) : null, t)
  const skuEntry = values.partKind === 'sku' && !checking && typedSku ? catalog.entries.get(typedSku) : undefined

  const surchargeRules = sortByOrder(definition.rules.filter((rule) => rule.effect === 'surcharge'))
  const boundElsewhere = values.ruleId
    ? definition.bom.filter((entry) => entry.ruleId === values.ruleId && entry.id !== line?.id).map((entry) => entry.id)
    : []

  const save = () => {
    if (disabled || checking || hasInvalid) return
    const result = formToLine(values, { otherIds, definition, uom })
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSave(result.line)
  }

  const unitValue = () => {
    if (checking) return t('product_configurator.studio.bom.unit.checking', 'Checking the catalog…')
    if (summary.commonUnit) return summary.commonUnit
    if (keptUom) return t('product_configurator.studio.bom.unit.kept', '{unit} (saved, not confirmed by the catalog)', { unit: keptUom })
    if (values.partKind === 'lookup' && summary.units.length > 1) return t('product_configurator.studio.bom.unit.noCommon', 'no common unit')
    return '—'
  }

  const generalErrors = [
    ...new Set(
      Object.entries(errors)
        .filter(([field]) => !INLINE_ERROR_FIELDS.has(field))
        .map(([, messageKey]) => t(messageKey)),
    ),
  ]
  const noRuleLabel = t('product_configurator.studio.bom.noRule', 'None')

  return (
    <CommitValidityScope value={validity}>
      <section
        className="space-y-4 rounded-lg border border-border bg-card p-4"
        data-testid="bom-line-editor"
        aria-labelledby={fieldId('title')}
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
        <h3 id={fieldId('title')} className="text-sm font-semibold text-foreground">
          {line
            ? t('product_configurator.studio.bom.editTitle', 'Edit line: {name}', { name: line.id })
            : t('product_configurator.studio.bom.newTitle', 'New line')}
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

        <BomPartFields
          values={values}
          onChange={set}
          definition={definition}
          skuEntry={skuEntry}
          error={error}
          fieldId={fieldId}
          disabled={disabled}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.bom.quantity', 'Quantity')}</p>
            <SegmentedControl
              value={values.quantityKind}
              disabled={disabled}
              aria-label={t('product_configurator.studio.bom.quantity', 'Quantity')}
              onValueChange={(next) => {
                const quantityKind = QUANTITY_KINDS.find((entry) => entry === next)
                if (quantityKind) set({ quantityKind })
              }}
            >
              <SegmentedControlItem value="number">{t('product_configurator.studio.bom.quantityKinds.number', 'Number')}</SegmentedControlItem>
              <SegmentedControlItem value="formula">{t('product_configurator.studio.bom.quantityKinds.formula', 'Formula')}</SegmentedControlItem>
            </SegmentedControl>
            {values.quantityKind === 'number' ? (
              <FormField
                id={fieldId('quantity')}
                label={t('product_configurator.studio.bom.quantityValue', 'Quantity per configured product')}
                error={error('quantity')}
              >
                <Input inputMode="decimal" value={values.quantity} disabled={disabled} onChange={(event) => set({ quantity: event.target.value })} />
              </FormField>
            ) : (
              <FormField id={fieldId('formula')} label={t('product_configurator.studio.bom.formula', 'Formula')} error={error('formulaKey')}>
                <KeySelect
                  value={values.formulaKey}
                  options={definition.formulas.map((formula) => ({ value: formula.key, label: friendlyName(formula.label, formula.key) }))}
                  placeholder={t('product_configurator.studio.bom.pickFormula', 'Pick a formula')}
                  disabled={disabled}
                  onChange={(formulaKey) => set({ formulaKey })}
                />
              </FormField>
            )}
          </div>
          <BomUnitField
            unitText={unitValue()}
            skuEntry={skuEntry}
            problems={problems}
            unitList={values.partKind === 'lookup' && summary.units.length > 1 ? unitList(summary) : null}
            error={error('unit')}
          />
        </div>

        <ConditionRows
          value={values.when}
          onChange={(when) => set({ when })}
          definition={definition}
          disabled={disabled}
          label={t('product_configurator.studio.bom.when', 'Included when (all must be true)')}
        />

        <div className="grid gap-3 md:grid-cols-3">
          <div className="min-w-0 space-y-1">
            <FormField id={fieldId('rule')} label={t('product_configurator.studio.bom.rule', 'Surcharge rule')} error={error('ruleId')}>
              <KeySelect
                value={values.ruleId || NO_RULE}
                options={[{ value: NO_RULE, label: noRuleLabel }, ...surchargeRules.map((rule) => ({ value: rule.id, label: ruleName(definition, rule.id) }))]}
                placeholder={noRuleLabel}
                disabled={disabled}
                onChange={(next) => set({ ruleId: next === NO_RULE ? '' : next })}
              />
            </FormField>
            {boundElsewhere.length > 0 ? (
              <p className="text-xs text-status-warning-text">
                {t('product_configurator.studio.bom.ruleBoundElsewhere', 'This rule is already bound to {lines}. A surcharge rule can be bound to one line only.', {
                  lines: boundElsewhere.join(', '),
                })}
              </p>
            ) : null}
          </div>
          <FormField id={fieldId('id')} className="min-w-0" label={t('product_configurator.studio.bom.id', 'Line id')} error={error('id')}>
            <Input className="font-mono" value={values.id} disabled={disabled} onChange={(event) => set({ id: event.target.value })} />
          </FormField>
          <FormField id={fieldId('order')} className="min-w-0" label={t('product_configurator.studio.bom.order', 'Order')} error={error('order')}>
            <Input inputMode="numeric" value={values.order} disabled={disabled} onChange={(event) => set({ order: event.target.value })} />
          </FormField>
        </div>

        {generalErrors.length > 0 ? (
          <div className="space-y-1" role="alert">
            {generalErrors.map((message) => (
              <p key={message} className="text-sm text-status-error-text">
                {message}
              </p>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasInvalid ? (
            <p id={invalidHintId} className="text-sm text-status-error-text">
              {t('product_configurator.studio.bom.fixInvalid', 'Fix the highlighted values to save the line.')}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('ui.actions.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={disabled || checking || hasInvalid}
            aria-describedby={hasInvalid ? invalidHintId : undefined}
          >
            {t('product_configurator.studio.bom.save', 'Save line')}
          </Button>
        </div>
      </section>
    </CommitValidityScope>
  )
}
