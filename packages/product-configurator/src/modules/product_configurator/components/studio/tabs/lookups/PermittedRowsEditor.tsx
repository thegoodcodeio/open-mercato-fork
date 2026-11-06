"use client"

import * as React from 'react'
import { Plus, X } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import type { ValueOption } from '../../conditionRowsModel'
import { lookupErrorText, togglePermittedValue, type LookupFormErrors, type PermittedRowForm } from './lookupForm'
import { NoMatchingRows, RowPager, RowSearch } from './RowWindowControls'
import { LOOKUP_ROWS_PAGE_SIZE, useRowWindow } from './useRowWindow'

type PermittedRowsEditorProps = {
  rows: PermittedRowForm[]
  onChange: (rows: PermittedRowForm[]) => void
  /** Options of the key feature; `null` when rows are typed freely (number feature). */
  domain: ValueOption[] | null
  keyFeatureName: string
  /** Values a row can allow (chips), in display order. */
  valueDomain: ValueOption[]
  /** True when no limited feature lists its own options, so new values are typed here. */
  canAddValues: boolean
  onAddValue: (value: string) => void
  errors: LookupFormErrors
  focus: { index: number } | null
  disabled: boolean
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="mt-1 text-xs text-status-error-text">
      {message}
    </p>
  ) : null
}

export function PermittedRowsEditor({
  rows,
  onChange,
  domain,
  keyFeatureName,
  valueDomain,
  canAddValues,
  onAddValue,
  errors,
  focus,
  disabled,
}: PermittedRowsEditorProps) {
  const t = useT()
  const [newValue, setNewValue] = React.useState('')
  const optionLabels = React.useMemo(() => new Map((domain ?? []).map((option) => [option.value, option.label])), [domain])
  const valueLabels = React.useMemo(() => new Map(valueDomain.map((option) => [option.value, option.label])), [valueDomain])
  const rowWindow = useRowWindow(
    rows,
    (row, query) => row.match.toLowerCase().includes(query) || (optionLabels.get(row.match) ?? '').toLowerCase().includes(query),
    focus,
  )
  const errorText = (field: string) => lookupErrorText(errors, field, t)
  const baseId = React.useId()
  const errorId = (field: string) => `${baseId}-${field}`
  const update = (index: number, next: PermittedRowForm) => onChange(rows.map((row, position) => (position === index ? next : row)))
  const remove = (index: number) => onChange(rows.filter((_, position) => position !== index))
  const addRow = () => {
    onChange([...rows, { match: '', values: [], default: '' }])
    rowWindow.setQuery('')
    rowWindow.setPage(Math.floor(rows.length / LOOKUP_ROWS_PAGE_SIZE) + 1)
  }
  const trimmedNewValue = newValue.trim()
  const addValue = () => {
    if (!trimmedNewValue || valueLabels.has(trimmedNewValue)) return
    onAddValue(trimmedNewValue)
    setNewValue('')
  }

  return (
    <div className="space-y-3" data-testid="lookup-permitted-rows">
      {canAddValues ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            size="sm"
            className="max-w-xs font-mono"
            value={newValue}
            disabled={disabled}
            aria-label={t('product_configurator.studio.lookups.newValue', 'New allowed value')}
            placeholder={t('product_configurator.studio.lookups.newValue', 'New allowed value')}
            onChange={(event) => setNewValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.preventDefault()
                addValue()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={addValue} disabled={disabled || !trimmedNewValue || valueLabels.has(trimmedNewValue)}>
            <Plus className="size-4" aria-hidden="true" />
            {t('product_configurator.studio.lookups.addValue', 'Add value')}
          </Button>
        </div>
      ) : null}
      <RowSearch rowWindow={rowWindow} rowCount={rows.length} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('product_configurator.studio.lookups.whenKeyIs', 'When {feature} is', { feature: keyFeatureName })}</TableHead>
            <TableHead>{t('product_configurator.studio.lookups.allowed', 'Allowed values')}</TableHead>
            <TableHead>{t('product_configurator.studio.lookups.default', 'Default')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('product_configurator.studio.lookups.rowActions', 'Row actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowWindow.visible.map(({ row, index }) => {
            const optionLabel = optionLabels.get(row.match)
            const matchName = optionLabel ?? (row.match || t('product_configurator.studio.lookups.rowName', '#{row}', { row: index + 1 }))
            const matchError = errorText(`rows.${index}.match`)
            const valuesError = errorText(`rows.${index}.values`)
            const defaultError = errorText(`rows.${index}.default`)
            return (
              <TableRow key={index} data-testid="lookup-permitted-row">
                <TableCell className="align-top">
                  {optionLabel !== undefined ? (
                    <span className="text-sm text-foreground">{optionLabel}</span>
                  ) : (
                    <>
                      <Input
                        size="sm"
                        className="font-mono"
                        value={row.match}
                        disabled={disabled}
                        aria-label={t('product_configurator.studio.lookups.matchLabelRow', 'Row {row}: when {feature} is', { row: index + 1, feature: keyFeatureName })}
                        aria-invalid={matchError ? true : undefined}
                        aria-describedby={matchError ? errorId(`${index}-match`) : undefined}
                        onChange={(event) => update(index, { ...row, match: event.target.value })}
                      />
                      {domain ? (
                        <p className="mt-1 text-xs text-status-warning-text">
                          {t('product_configurator.studio.lookups.notAnOption', 'Not an option of {feature}.', { feature: keyFeatureName })}
                        </p>
                      ) : null}
                    </>
                  )}
                  <FieldError id={errorId(`${index}-match`)} message={matchError} />
                </TableCell>
                <TableCell className="align-top">
                  <div
                    role="group"
                    aria-label={t('product_configurator.studio.lookups.allowedFor', 'Allowed values for {match}', { match: matchName })}
                    aria-describedby={valuesError ? errorId(`${index}-values`) : undefined}
                    className="flex flex-wrap gap-1"
                  >
                    {valueDomain.map((option) => {
                      const allowed = row.values.includes(option.value)
                      return (
                        <Button
                          key={option.value}
                          type="button"
                          size="2xs"
                          variant={allowed ? 'default' : 'outline'}
                          aria-pressed={allowed}
                          disabled={disabled}
                          onClick={() => update(index, togglePermittedValue(row, option.value, valueDomain))}
                        >
                          {option.label}
                        </Button>
                      )
                    })}
                  </div>
                  {valueDomain.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('product_configurator.studio.lookups.noValues', 'No values to allow yet.')}
                    </p>
                  ) : null}
                  <FieldError id={errorId(`${index}-values`)} message={valuesError} />
                </TableCell>
                <TableCell className="min-w-40 align-top">
                  <Select
                    value={row.default || undefined}
                    onValueChange={(next) => update(index, { ...row, default: next })}
                    disabled={disabled || row.values.length === 0}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={t('product_configurator.studio.lookups.defaultFor', 'Default for {match}', { match: matchName })}
                      aria-invalid={defaultError ? true : undefined}
                      aria-describedby={defaultError ? errorId(`${index}-default`) : undefined}
                    >
                      <SelectValue
                        placeholder={
                          optionLabel !== undefined && row.values.length === 0
                            ? t('product_configurator.studio.lookups.noRowPlaceholder', 'No row')
                            : t('product_configurator.studio.lookups.pickDefault', 'Pick the default')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {row.values.map((value) => (
                        <SelectItem key={value} value={value}>
                          {valueLabels.get(value) ?? value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError id={errorId(`${index}-default`)} message={defaultError} />
                </TableCell>
                <TableCell className="w-10 align-top">
                  {optionLabel === undefined ? (
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t('product_configurator.studio.lookups.removeRow', 'Remove row {match}', { match: matchName })}
                      onClick={() => remove(index)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </TableCell>
              </TableRow>
            )
          })}
          <NoMatchingRows rowWindow={rowWindow} colSpan={4} />
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center gap-2">
        {domain ? null : (
          <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={disabled}>
            <Plus className="size-4" aria-hidden="true" />
            {t('product_configurator.studio.lookups.addRow', 'Add row')}
          </Button>
        )}
        <div className="ml-auto">
          <RowPager rowWindow={rowWindow} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('product_configurator.studio.lookups.defaultHint', 'The default must be one of the allowed values. An option with no allowed value has no row.')}
      </p>
    </div>
  )
}
