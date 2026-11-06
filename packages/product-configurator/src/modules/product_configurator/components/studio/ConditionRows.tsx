"use client"

import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import type { Condition, Feature } from '../../data/validators'
import { INCLUDES_TOKEN_SEPARATOR } from '../../data/validators'
import { sortByOrder, toFiniteNumber } from '../../lib/values'
import {
  COMPARE_OPS,
  CONDITION_GROUPS,
  OPERATOR_LABELS,
  ORDERING_OPS,
  defaultCondition,
  featureValueOptions,
  isOrderingOp,
  withCompareOp,
  withFeatureKey,
  type ConditionGroup,
  type ValueOption,
} from './conditionRowsModel'
import { friendlyName } from './names'
import { CommitInput } from './CommitInput'
import { KeySelect, type KeySelectProps } from './KeySelect'
import type { StudioDefinition } from './tabs/types'

export type ConditionRowsProps = {
  value: readonly Condition[]
  onChange: (next: Condition[]) => void
  definition: StudioDefinition
  /** Leaves a feature out of the pickers, e.g. the feature whose `visibleWhen` is edited. */
  excludeFeatureKey?: string
  disabled?: boolean
  /** Heading above the rows; defaults to "When (all must be true)". */
  label?: string
}

const GROUP_LABELS: Record<ConditionGroup, { key: string; fallback: string }> = {
  feature: { key: 'product_configurator.studio.conditions.groups.feature', fallback: 'Feature value' },
  calculated: { key: 'product_configurator.studio.conditions.groups.calculated', fallback: 'Calculated value' },
  text: { key: 'product_configurator.studio.conditions.groups.text', fallback: 'Text contains' },
  lookup: { key: 'product_configurator.studio.conditions.groups.lookup', fallback: 'Not in lookup' },
}

function Picker(props: KeySelectProps) {
  return <KeySelect size="sm" className="min-w-0 flex-1 basis-36" {...props} />
}

function parseToken(text: string): string | null {
  const token = text.trim()
  return token && token.split(INCLUDES_TOKEN_SEPARATOR).length === 1 ? token : null
}

type RowProps = {
  condition: Condition
  /** 1-based position, used in the row's accessible name. */
  position: number
  definition: StudioDefinition
  features: readonly Feature[]
  disabled?: boolean
  onChange: (next: Condition) => void
  onRemove: () => void
}

function ConditionRow({ condition, position, definition, features, disabled, onChange, onRemove }: RowProps) {
  const t = useT()
  const opLabel = (key: keyof typeof OPERATOR_LABELS) => t(OPERATOR_LABELS[key].key, OPERATOR_LABELS[key].fallback)
  const featureOptions = features.map((feature) => ({ value: feature.key, label: friendlyName(feature.label, feature.key) }))
  const numberError = t('product_configurator.studio.conditions.numberRequired', 'Enter a number.')
  const featurePicker =
    condition.kind === 'calculated' ? null : (
      <Picker
        value={condition.featureKey}
        options={featureOptions}
        disabled={disabled}
        ariaLabel={t('product_configurator.studio.conditions.feature', 'Feature')}
        onChange={(key) => onChange(withFeatureKey(condition, key, definition))}
      />
    )

  const valueControl = () => {
    switch (condition.kind) {
      case 'compare': {
        const feature = definition.features.find((entry) => entry.key === condition.featureKey)
        const options: ValueOption[] = isOrderingOp(condition.op) ? [] : featureValueOptions(definition, feature, t)
        if (options.length > 0) {
          return (
            <Picker
              value={String(condition.value)}
              options={options}
              disabled={disabled}
              ariaLabel={t('product_configurator.studio.conditions.value', 'Value')}
              onChange={(next) => onChange({ ...condition, value: feature?.type === 'boolean' ? next === 'true' : next })}
            />
          )
        }
        if (isOrderingOp(condition.op) || feature?.type === 'number') {
          return (
            <CommitInput
              value={String(condition.value)}
              parse={toFiniteNumber}
              error={numberError}
              disabled={disabled}
              ariaLabel={t('product_configurator.studio.conditions.value', 'Value')}
              onCommit={(next) => onChange({ ...condition, value: next })}
            />
          )
        }
        return (
          <CommitInput
            value={String(condition.value)}
            parse={(text) => text}
            error=""
            disabled={disabled}
            ariaLabel={t('product_configurator.studio.conditions.value', 'Value')}
            onCommit={(next) => onChange({ ...condition, value: next })}
          />
        )
      }
      case 'includes':
      case 'not_includes':
        return (
          <CommitInput
            value={condition.value}
            parse={parseToken}
            error={t('product_configurator.studio.conditions.tokenRequired', 'Enter one word without spaces.')}
            disabled={disabled}
            ariaLabel={t('product_configurator.studio.conditions.text', 'Text')}
            onCommit={(next) => onChange({ ...condition, value: next })}
          />
        )
      case 'not_in_lookup':
        return (
          <Picker
            value={condition.lookupKey}
            options={definition.lookups.map((lookup) => ({ value: lookup.key, label: friendlyName(lookup.label, lookup.key) }))}
            disabled={disabled}
            ariaLabel={t('product_configurator.studio.conditions.lookup', 'Lookup')}
            onChange={(key) => {
              const lookup = definition.lookups.find((entry) => entry.key === key)
              if (lookup) onChange({ ...condition, lookupKey: lookup.key, keyedBy: lookup.keyedBy })
            }}
          />
        )
      case 'calculated':
        return (
          <CommitInput
            value={String(condition.value)}
            parse={toFiniteNumber}
            error={numberError}
            disabled={disabled}
            ariaLabel={t('product_configurator.studio.conditions.value', 'Value')}
            onCommit={(next) => onChange({ ...condition, value: next })}
          />
        )
    }
  }

  const operatorControl = () => {
    const ariaLabel = t('product_configurator.studio.conditions.operator', 'Operator')
    switch (condition.kind) {
      case 'compare':
        return (
          <Picker value={condition.op} ariaLabel={ariaLabel} disabled={disabled}
            options={COMPARE_OPS.map((op) => ({ value: op, label: opLabel(op) }))}
            onChange={(op) => {
              const next = COMPARE_OPS.find((entry) => entry === op)
              if (next) onChange(withCompareOp(condition, next, definition))
            }}
          />
        )
      case 'includes':
      case 'not_includes':
        return (
          <Picker value={condition.kind} ariaLabel={ariaLabel} disabled={disabled}
            options={[{ value: 'includes', label: opLabel('includes') }, { value: 'not_includes', label: opLabel('not_includes') }]}
            onChange={(kind) => onChange({ kind: kind === 'not_includes' ? 'not_includes' : 'includes', featureKey: condition.featureKey, value: condition.value })}
          />
        )
      case 'not_in_lookup':
        return <span className="text-sm text-muted-foreground">{opLabel('not_in_lookup')}</span>
      case 'calculated':
        return (
          <Picker value={condition.op} ariaLabel={ariaLabel} disabled={disabled}
            options={ORDERING_OPS.map((op) => ({ value: op, label: opLabel(op) }))}
            onChange={(op) => {
              const next = ORDERING_OPS.find((entry) => entry === op)
              if (next) onChange({ ...condition, op: next })
            }}
          />
        )
    }
  }

  return (
    <div
      role="group"
      aria-label={t('product_configurator.studio.conditions.row', 'Condition {position}', { position })}
      className="flex min-w-0 flex-wrap items-start gap-2"
      data-testid="condition-row"
      data-condition-kind={condition.kind}
    >
      {condition.kind === 'calculated' ? (
        <Picker
          value={condition.formulaKey}
          options={definition.formulas.map((formula) => ({ value: formula.key, label: friendlyName(formula.label, formula.key) }))}
          disabled={disabled}
          ariaLabel={t('product_configurator.studio.conditions.formula', 'Calculated value')}
          onChange={(formulaKey) => onChange({ ...condition, formulaKey })}
        />
      ) : (
        featurePicker
      )}
      {operatorControl()}
      {valueControl()}
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onRemove}
        aria-label={t('product_configurator.studio.conditions.removeRow', 'Remove condition {position}', { position })}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </IconButton>
    </div>
  )
}

/**
 * Keys rows by an id that stays with the row when an earlier row is removed, so a row's half-typed text does
 * not move to its neighbour. Rows added or removed by the parent get fresh ids at the end.
 */
function useRowIds(count: number): { ids: readonly string[]; remove: (index: number) => void } {
  const counter = React.useRef(0)
  const ids = React.useRef<string[]>([])
  if (ids.current.length > count) ids.current = ids.current.slice(0, count)
  while (ids.current.length < count) ids.current = [...ids.current, `condition-${counter.current++}`]
  const remove = (index: number) => {
    ids.current = ids.current.filter((_, position) => position !== index)
  }
  return { ids: ids.current, remove }
}

/** AND-combined condition editor shared by `visibleWhen`, rules and BOM lines. Every emitted condition passes `conditionSchema`. */
export function ConditionRows({ value, onChange, definition, excludeFeatureKey, disabled, label }: ConditionRowsProps) {
  const t = useT()
  const features = React.useMemo(
    () => sortByOrder(definition.features).filter((feature) => feature.key !== excludeFeatureKey),
    [definition.features, excludeFeatureKey],
  )
  const replaceAt = (index: number, next: Condition) => onChange(value.map((entry, position) => (position === index ? next : entry)))
  const labelId = React.useId()
  const rowIds = useRowIds(value.length)

  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-2" data-testid="condition-rows">
      <p id={labelId} className="text-sm font-medium text-foreground">{label ?? t('product_configurator.studio.conditions.label', 'When (all must be true)')}</p>
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('product_configurator.studio.conditions.empty', 'No conditions: always true.')}</p>
      ) : null}
      {value.map((condition, index) => (
        <ConditionRow
          key={rowIds.ids[index]}
          condition={condition}
          position={index + 1}
          definition={definition}
          features={features}
          disabled={disabled}
          onChange={(next) => replaceAt(index, next)}
          onRemove={() => {
            rowIds.remove(index)
            onChange(value.filter((_, position) => position !== index))
          }}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        {CONDITION_GROUPS.map((group) => {
          const created = defaultCondition(group, definition, features)
          return (
            <Button key={group} type="button" variant="outline" size="sm" disabled={disabled || !created} onClick={() => created && onChange([...value, created])}>
              <Plus className="size-4" aria-hidden="true" />
              {t(GROUP_LABELS[group].key, GROUP_LABELS[group].fallback)}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
