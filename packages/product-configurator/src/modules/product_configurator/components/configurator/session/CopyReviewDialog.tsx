"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import type { ConfigurationDefinition } from '../../../data/validators'
import type { WorkspaceEvaluation } from '../evaluationSchema'
import { currentValueText, migrationReasonText, oldValueText } from './migrationText'
import type { SelectionMigration } from './sessionApi'

type CopyReviewDialogProps = {
  definition: ConfigurationDefinition
  migration: SelectionMigration
  evaluation: WorkspaceEvaluation | null
  /** Header of the copy, "Copy of: <line name>". */
  title: string
  busy: boolean
  onEditChoices: () => void
  onConfirm: () => void
}

/**
 * Copy review before a copy opened on a newer model version is added: the copied choices that moved (old and
 * new value with the reason), "I reviewed the changed choices" and "Add to quote". No commercial terms, because
 * a copy starts with new-line defaults. Escape returns to the workspace, Cmd/Ctrl+Enter adds once reviewed.
 */
export function CopyReviewDialog({ definition, migration, evaluation, title, busy, onEditChoices, onConfirm }: CopyReviewDialogProps) {
  const t = useT()
  const locale = useLocale()
  const [reviewed, setReviewed] = React.useState(false)
  const checkboxId = React.useId()
  const canConfirm = reviewed && !busy && evaluation !== null
  const confirm = () => {
    if (canConfirm) onConfirm()
  }
  const rows = [
    ...migration.reset.map((item) => ({ item, now: currentValueText(definition, evaluation, item.featureKey, locale, t) ?? '-' })),
    ...migration.dropped.map((item) => ({ item, now: t('product_configurator.configurator.migration.removedValue', 'Removed') })),
  ]

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onEditChoices())}>
      <DialogContent
        data-testid="configurator-copy-review"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            confirm()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('product_configurator.configurator.migration.reviewText', 'Model v{version} changed some copied choices. Review them before the copy is added.', {
              version: migration.toVersion.version,
            })}
          </DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('product_configurator.configurator.migration.field', 'Field')}</TableHead>
              <TableHead>{t('product_configurator.configurator.migration.copied', 'Copied (v{version})', { version: migration.fromVersion.version })}</TableHead>
              <TableHead>{t('product_configurator.configurator.migration.now', 'Now (v{version})', { version: migration.toVersion.version })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ item, now }) => (
              <TableRow key={item.featureKey} data-testid={`configurator-copy-review-${item.featureKey}`}>
                <TableCell>{item.label}</TableCell>
                <TableCell>{oldValueText(item, locale, t)}</TableCell>
                <TableCell>
                  <span className="block">{now}</span>
                  <span className="block text-xs text-muted-foreground">{migrationReasonText(item, migration, locale, t)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {evaluation ? (
          <p className="text-sm text-muted-foreground">
            {t('product_configurator.configurator.migration.newPrice', 'New price {price}. Name, comment and discount start as for a new line.', {
              price: formatCurrency(evaluation.netPrice, evaluation.currencyCode, locale) ?? evaluation.netPrice,
            })}
          </p>
        ) : null}
        <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm">
          <Checkbox id={checkboxId} checked={reviewed} onCheckedChange={(checked) => setReviewed(checked === true)} />
          {t('product_configurator.configurator.migration.reviewed', 'I reviewed the changed choices')}
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onEditChoices}>
            {t('product_configurator.configurator.migration.editChoices', 'Edit choices')}
          </Button>
          <Button type="button" disabled={!canConfirm} onClick={confirm} data-testid="configurator-copy-review-add">
            {t('product_configurator.configurator.addToQuote', 'Add to quote')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
