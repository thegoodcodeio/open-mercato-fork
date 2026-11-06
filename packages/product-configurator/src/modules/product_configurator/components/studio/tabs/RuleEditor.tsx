"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { TagsInput } from '@open-mercato/ui/backend/inputs/TagsInput'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { LinkButton } from '@open-mercato/ui/primitives/link-button'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import type { Rule } from '../../../data/validators'
import { sortByOrder } from '../../../lib/values'
import { CommitValidityScope, useCommitValidity } from '../CommitInput'
import { ConditionRows } from '../ConditionRows'
import { conditionFeatureKeys } from '../conditionRowsModel'
import { featureName, friendlyName } from '../names'
import { issueMessage } from '../validationMessages'
import { RuleActionEditor } from './RuleActionEditor'
import { RuleMessageEditor } from './RuleMessageEditor'
import { useRowEditorDirty } from './rowEditorSession'
import { RULE_EFFECTS, RULE_ERROR_FALLBACKS, formToRule, ruleToForm, surchargeLineIds, withConditions, type RuleEffect, type RuleFormErrors, type RuleFormValues } from './ruleForm'
import type { StudioDefinition, StudioIssue } from './types'

type RuleEditorProps = {
  rule: Rule | undefined
  nextOrder: number
  definition: StudioDefinition
  otherIds: readonly string[]
  issues: StudioIssue[]
  disabled: boolean
  onSave: (rule: Rule) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}

export const EFFECT_LABELS: Record<RuleEffect, { key: string; fallback: string }> = {
  error: { key: 'product_configurator.studio.rules.effects.error', fallback: 'Blocks' },
  warning: { key: 'product_configurator.studio.rules.effects.warning', fallback: 'Warns' },
  force: { key: 'product_configurator.studio.rules.effects.force', fallback: 'Sets a value' },
  surcharge: { key: 'product_configurator.studio.rules.effects.surcharge', fallback: 'Surcharge' },
}

const INLINE_ERROR_FIELDS = new Set(['label', 'id', 'order'])

/** Errors the action editor shows next to its own controls. */
const INLINE_ACTION_ERROR = /^action\.(featureKey|setValue|lookupKey|mapRows(\.\d+\.(from|to))?)$/

/** Labels for errors that come from the schema check and have no control of their own, by the first segment of the field path. */
const ERROR_FIELD_LABELS: Record<string, { key: string; fallback: string }> = {
  effect: { key: 'product_configurator.studio.rules.effect', fallback: 'Effect' },
  when: { key: 'product_configurator.studio.conditions.label', fallback: 'When (all must be true)' },
  action: { key: 'product_configurator.studio.rules.action.kind', fallback: 'Then' },
  messageTemplate: { key: 'product_configurator.studio.rules.message.label', fallback: 'Message' },
  featureKeys: { key: 'product_configurator.studio.rules.featureKeys', fallback: 'Fields highlighted for the rep' },
}

function isInlineError(field: string): boolean {
  return INLINE_ERROR_FIELDS.has(field) || INLINE_ACTION_ERROR.test(field)
}

export function RuleEditor({ rule, nextOrder, definition, otherIds, issues, disabled, onSave, onCancel, onDirtyChange }: RuleEditorProps) {
  const t = useT()
  const idPrefix = React.useId()
  const [values, setValues] = React.useState<RuleFormValues>(() => ruleToForm(rule, nextOrder, definition))
  const [errors, setErrors] = React.useState<RuleFormErrors>({})
  const { hasInvalid, validity } = useCommitValidity()
  useRowEditorDirty(values, hasInvalid, onDirtyChange)
  const set = (patch: Partial<RuleFormValues>) => setValues((current) => ({ ...current, ...patch }))
  const error = (field: string) => (errors[field] ? t(errors[field], RULE_ERROR_FALLBACKS[errors[field]]) : undefined)
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const highlightedLabelId = fieldId('highlighted-label')
  const invalidHintId = fieldId('invalid-hint')
  const lineIds = surchargeLineIds(definition, values.effect, rule?.id ?? values.id.trim())
  const featureSuggestions = React.useMemo(
    () => sortByOrder(definition.features).map((feature) => ({ value: feature.key, label: friendlyName(feature.label, feature.key) })),
    [definition.features],
  )
  const conditionKeys = conditionFeatureKeys(values.when)

  const save = () => {
    if (disabled || hasInvalid) return
    const result = formToRule(values, otherIds, definition)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSave(result.rule)
  }

  const otherErrors = Array.from(
    new Map(
      Object.entries(errors)
        .filter(([field]) => !isInlineError(field))
        .map(([field, messageKey]) => [field.split('.')[0], messageKey] as const),
    ),
  )

  return (
    <CommitValidityScope value={validity}>
      <section
        className="space-y-4 rounded-lg border border-border bg-card p-4"
        data-testid="rule-editor"
        aria-label={rule ? friendlyName(rule.label, rule.id) : t('product_configurator.studio.rules.newTitle', 'New rule')}
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
          {rule
            ? t('product_configurator.studio.rules.editTitle', 'Edit rule: {name}', { name: rule.label ?? rule.id })
            : t('product_configurator.studio.rules.newTitle', 'New rule')}
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
        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <FormField label={t('product_configurator.studio.rules.label', 'Name')} error={error('label')}>
              <Input value={values.label} disabled={disabled} onChange={(event) => set({ label: event.target.value })} />
            </FormField>
          </div>
          <FormField label={t('product_configurator.studio.rules.id', 'Id')} error={error('id')}>
            <Input inputClassName="font-mono" value={values.id} disabled={disabled} onChange={(event) => set({ id: event.target.value })} />
          </FormField>
          <FormField label={t('product_configurator.studio.rules.order', 'Order')} error={error('order')}>
            <Input inputMode="numeric" value={values.order} disabled={disabled} onChange={(event) => set({ order: event.target.value })} />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('product_configurator.studio.rules.idHint', 'The name is for people; the id stays stable for the model. Reports show both.')}
        </p>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.rules.effect', 'Effect')}</p>
          <SegmentedControl
            value={values.effect}
            disabled={disabled}
            aria-label={t('product_configurator.studio.rules.effect', 'Effect')}
            onValueChange={(next) => {
              const effect = RULE_EFFECTS.find((entry) => entry === next)
              if (effect) set({ effect })
            }}
          >
            {RULE_EFFECTS.map((effect) => (
              <SegmentedControlItem key={effect} value={effect}>
                {t(EFFECT_LABELS[effect].key, EFFECT_LABELS[effect].fallback)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <ConditionRows
          value={values.when}
          onChange={(when) => setValues((current) => withConditions(current, when))}
          definition={definition}
          disabled={disabled}
          label={t('product_configurator.studio.rules.when', 'When (all must be true)')}
        />
        {values.effect === 'force' ? (
          <RuleActionEditor action={values.action} definition={definition} errors={errors} disabled={disabled} onChange={(action) => set({ action })} />
        ) : null}
        <RuleMessageEditor
          value={values.messageTemplate}
          definition={definition}
          lineIds={lineIds}
          surcharge={values.effect === 'surcharge'}
          disabled={disabled}
          onChange={(messageTemplate) => set({ messageTemplate })}
        />
        <div className="space-y-1">
          <p id={highlightedLabelId} className="text-sm font-medium text-foreground">
            {t('product_configurator.studio.rules.featureKeys', 'Fields highlighted for the rep')}
          </p>
          <div role="group" aria-labelledby={highlightedLabelId} data-testid="rule-feature-keys">
            <TagsInput
              value={values.featureKeys}
              onChange={(featureKeys) => set({ featureKeys, featureKeysEdited: true })}
              suggestions={featureSuggestions}
              resolveLabel={(key) => featureName(definition, key)}
              allowCustomValues={false}
              disabled={disabled}
              placeholder={t('product_configurator.studio.rules.featureKeysPlaceholder', 'Add a field')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {t('product_configurator.studio.rules.featureKeysHint', 'Prefilled with the fields used in the conditions. Message links on the rep screen go to these fields.')}
            </p>
            {values.featureKeysEdited ? (
              <LinkButton size="sm" disabled={disabled} onClick={() => set({ featureKeys: conditionKeys, featureKeysEdited: false })}>
                {t('product_configurator.studio.rules.featureKeysReset', 'Use the fields from the conditions')}
              </LinkButton>
            ) : null}
          </div>
        </div>
        {otherErrors.length > 0 ? (
          <ul role="alert" className="space-y-1 text-sm text-status-error-text">
            {otherErrors.map(([field, messageKey]) => {
              const message = t(messageKey, RULE_ERROR_FALLBACKS[messageKey])
              const label = ERROR_FIELD_LABELS[field]
              return (
                <li key={field}>
                  {label
                    ? t('product_configurator.studio.rules.errors.field', '{field}: {message}', { field: t(label.key, label.fallback), message })
                    : message}
                </li>
              )
            })}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasInvalid ? (
            <p id={invalidHintId} className="text-sm text-status-error-text">
              {t('product_configurator.studio.rules.fixInvalid', 'Fix the highlighted values to save the rule.')}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('ui.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={disabled || hasInvalid} aria-describedby={hasInvalid ? invalidHintId : undefined}>
            {t('product_configurator.studio.rules.save', 'Save rule')}
          </Button>
        </div>
      </section>
    </CommitValidityScope>
  )
}
