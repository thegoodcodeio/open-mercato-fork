"use client"

import * as React from 'react'
import { Check, Plus, X } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import type { ValueOption } from '../../conditionRowsModel'
import { lookupErrorText, valueRowHasValue, type LookupFormErrors, type ValueRowForm } from './lookupForm'
import { NoMatchingRows, RowPager, RowSearch } from './RowWindowControls'
import { LOOKUP_ROWS_PAGE_SIZE, useRowWindow } from './useRowWindow'
import { useSkuCheck, type SkuStatus } from './useSkuCheck'

type ValueRowsEditorProps = {
  rows: ValueRowForm[]
  onChange: (rows: ValueRowForm[]) => void
  /** Options of the key feature; `null` when rows are typed freely (number feature). */
  domain: ValueOption[] | null
  keyFeatureName: string
  /** The values are catalog SKUs (a BOM line reads them), so they are checked against the catalog. */
  skuValues: boolean
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

function SkuCheck({ status }: { status: SkuStatus | undefined }) {
  const t = useT()
  if (!status) return null
  switch (status.state) {
    case 'found':
      return (
        <span className="inline-flex items-center gap-1 text-sm text-status-success-text">
          <Check className="size-4 shrink-0" aria-hidden="true" />
          {status.title}
        </span>
      )
    case 'unknown':
      return <span className="text-sm text-status-error-text">{t('product_configurator.studio.lookups.skuUnknown', 'Unknown SKU: not found in the catalog.')}</span>
    case 'ambiguous':
      return (
        <span className="text-sm text-status-error-text">
          {t('product_configurator.studio.lookups.skuAmbiguous', 'Ambiguous SKU: a product and a variant both use it.')}
        </span>
      )
    case 'unavailable':
      return (
        <span className="text-sm text-muted-foreground">
          {t('product_configurator.studio.lookups.skuUnavailable', 'Catalog check unavailable. Validate checks the saved draft.')}
        </span>
      )
  }
}

export function ValueRowsEditor({ rows, onChange, domain, keyFeatureName, skuValues, errors, focus, disabled }: ValueRowsEditorProps) {
  const t = useT()
  const optionLabels = React.useMemo(() => new Map((domain ?? []).map((option) => [option.value, option.label])), [domain])
  const rowWindow = useRowWindow(
    rows,
    (row, query) =>
      row.match.toLowerCase().includes(query) ||
      (optionLabels.get(row.match) ?? '').toLowerCase().includes(query) ||
      row.text.toLowerCase().includes(query),
    focus,
  )
  const statuses = useSkuCheck(
    rowWindow.visible.map(({ row }) => row.text),
    skuValues,
  )
  const errorText = (field: string) => lookupErrorText(errors, field, t)
  const baseId = React.useId()
  const errorId = (field: string) => `${baseId}-${field}`
  const update = (index: number, patch: Partial<ValueRowForm>) =>
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)))
  const remove = (index: number) => onChange(rows.filter((_, position) => position !== index))
  const addRow = () => {
    onChange([...rows, { match: '', text: '' }])
    rowWindow.setQuery('')
    rowWindow.setPage(Math.floor(rows.length / LOOKUP_ROWS_PAGE_SIZE) + 1)
  }
  const columnCount = skuValues ? 4 : 3

  return (
    <div className="space-y-3" data-testid="lookup-value-rows">
      <RowSearch rowWindow={rowWindow} rowCount={rows.length} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('product_configurator.studio.lookups.whenKeyIs', 'When {feature} is', { feature: keyFeatureName })}</TableHead>
            <TableHead>{t('product_configurator.studio.lookups.value', 'Value')}</TableHead>
            {skuValues ? <TableHead>{t('product_configurator.studio.lookups.catalogCheck', 'Catalog check')}</TableHead> : null}
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
            const valueError = errorText(`rows.${index}.value`)
            return (
              <TableRow key={index} data-testid="lookup-value-row">
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
                        onChange={(event) => update(index, { match: event.target.value })}
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
                  <Input
                    size="sm"
                    className={skuValues ? 'font-mono' : undefined}
                    value={row.text}
                    disabled={disabled}
                    placeholder={optionLabel !== undefined && !valueRowHasValue(row) ? t('product_configurator.studio.lookups.noRowPlaceholder', 'No row') : undefined}
                    aria-label={t('product_configurator.studio.lookups.valueFor', 'Value for {match}', { match: matchName })}
                    aria-invalid={valueError ? true : undefined}
                    aria-describedby={valueError ? errorId(`${index}-value`) : undefined}
                    onChange={(event) => update(index, { text: event.target.value })}
                  />
                  <FieldError id={errorId(`${index}-value`)} message={valueError} />
                </TableCell>
                {skuValues ? (
                  <TableCell className="align-top">
                    <SkuCheck status={statuses.get(row.text.trim())} />
                  </TableCell>
                ) : null}
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
          <NoMatchingRows rowWindow={rowWindow} colSpan={columnCount} />
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
    </div>
  )
}
