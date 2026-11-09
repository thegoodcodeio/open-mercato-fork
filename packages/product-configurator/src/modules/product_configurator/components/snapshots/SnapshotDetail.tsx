"use client"

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import { QUOTES_LIST_HREF, quoteHref } from '../configurator/session/sessionApi'
import { snapshotLoadFromResponse, snapshotUrl, type SnapshotLoad, type SnapshotRow } from './snapshotsApi'

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function RowList({ rows }: { rows: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      {rows.map((row, index) => (
        <React.Fragment key={`${row.label}-${index}`}>
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="text-sm">{row.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** "Configuration details": what was configured, priced and added, read from the immutable snapshot. */
export function SnapshotDetail({ snapshotId }: { snapshotId: string }) {
  const t = useT()
  const locale = useLocale()
  const searchParams = useSearchParams()
  const quoteId = searchParams?.get('quoteId') || null
  const scopeVersion = useOrganizationScopeVersion()
  const [load, setLoad] = React.useState<SnapshotLoad | { status: 'loading' }>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    void apiCall<unknown>(snapshotUrl(snapshotId, quoteId), { cache: 'no-store' }).then(
      (call) => {
        if (!cancelled) setLoad(snapshotLoadFromResponse(call.status, call.result, snapshotId, quoteId !== null))
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [snapshotId, quoteId, scopeVersion, reloadToken])

  const backHref = quoteId ? quoteHref(quoteId) : QUOTES_LIST_HREF
  const backLabel = quoteId
    ? t('product_configurator.configurator.backToQuote', 'Back to quote')
    : t('product_configurator.configurator.goToQuotes', 'Go to quotes')

  if (load.status === 'loading') {
    return <LoadingMessage label={t('product_configurator.snapshot.loading', 'Loading the configuration details...')} />
  }
  if (load.status === 'not_found') {
    return <RecordNotFoundState label={t('product_configurator.snapshot.notFound', 'This configuration was not found.')} backHref={backHref} backLabel={backLabel} />
  }
  if (load.status === 'forbidden') {
    return <ErrorMessage label={t('product_configurator.snapshot.forbidden', 'You do not have access to this configuration.')} />
  }
  if (load.status === 'error') {
    return (
      <ErrorMessage
        label={t('product_configurator.snapshot.loadFailed', 'Could not load the configuration details.')}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            {t('product_configurator.configurator.retry', 'Retry')}
          </Button>
        }
      />
    )
  }

  const { snapshot } = load
  const money = (value: string) => formatCurrency(value, snapshot.currencyCode, locale) ?? value
  const number = (value: string | number, decimals?: number) =>
    new Intl.NumberFormat(locale, decimals === undefined ? undefined : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number(value))
  const rowValue = (row: SnapshotRow) => {
    const value =
      typeof row.value === 'boolean'
        ? row.value
          ? t('product_configurator.configurator.values.yes', 'Yes')
          : t('product_configurator.configurator.values.no', 'No')
        : typeof row.value === 'number'
          ? number(row.value, row.decimals)
          : row.value
    return row.unit ? `${value} ${row.unit}` : value
  }
  const addedAt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.createdAt))
  const subtitle = [
    snapshot.modelVersion.version !== null
      ? t('product_configurator.configurator.header.version', 'Model v{version}', { version: snapshot.modelVersion.version })
      : null,
    t('product_configurator.snapshot.addedAt', 'added to the quote {date}', { date: addedAt }),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return (
    <div className="space-y-4" data-testid="snapshot-detail">
      <FormHeader
        mode="detail"
        backHref={backHref}
        backLabel={backLabel}
        entityTypeLabel={t('product_configurator.snapshot.pageTitle', 'Configuration details')}
        title={snapshot.lineName ?? snapshot.modelTitle ?? t('product_configurator.configurator.header.untitled', 'Product configuration')}
        subtitle={subtitle}
        statusBadge={
          snapshot.lineState === 'removed' ? (
            <StatusBadge variant="warning" dot>
              {t('product_configurator.snapshot.lineRemoved', 'Line removed')}
            </StatusBadge>
          ) : (
            <StatusBadge variant="success" dot>
              {t('product_configurator.snapshot.onQuote', 'On quote')}
            </StatusBadge>
          )
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0 space-y-4">
          <Section title={t('product_configurator.snapshot.sections.choices', 'Choices')} testId="snapshot-choices">
            {snapshot.selectionRows.length ? (
              <RowList rows={snapshot.selectionRows.map((row) => ({ label: row.label, value: rowValue(row) }))} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('product_configurator.snapshot.noChoices', 'No choices to show.')}</p>
            )}
          </Section>
          {snapshot.calculatedRows.length ? (
            <Section title={t('product_configurator.snapshot.sections.calculated', 'Calculated values')} testId="snapshot-calculated">
              <RowList rows={snapshot.calculatedRows.map((row) => ({ label: row.label, value: rowValue(row) }))} />
            </Section>
          ) : null}
          {snapshot.specification.length ? (
            <Section title={t('product_configurator.snapshot.sections.specification', 'Specification')} testId="snapshot-specification">
              <RowList rows={snapshot.specification} />
            </Section>
          ) : null}
          {snapshot.warnings.length ? (
            <Section title={t('product_configurator.snapshot.sections.warnings', 'Warnings when added')} testId="snapshot-warnings">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {snapshot.warnings.map((warning, index) => (
                  <li key={`${warning.ruleId}-${index}`}>{warning.message || t('product_configurator.configurator.messages.ruleFallback', 'A rule of this model applies.')}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title={t('product_configurator.snapshot.sections.bom', 'Bill of materials')} testId="snapshot-bom">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('product_configurator.snapshot.bom.sku', 'SKU')}</TableHead>
                    <TableHead>{t('product_configurator.configurator.bom.part', 'Part')}</TableHead>
                    <TableHead className="text-right">{t('product_configurator.configurator.bom.quantity', 'Qty')}</TableHead>
                    <TableHead>{t('product_configurator.configurator.bom.unit', 'Unit')}</TableHead>
                    <TableHead className="text-right">{t('product_configurator.configurator.bom.unitPrice', 'Unit price')}</TableHead>
                    <TableHead className="text-right">{t('product_configurator.configurator.bom.total', 'Total')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.bom.map((line, index) => (
                    <TableRow key={`${line.sku}-${index}`}>
                      <TableCell className="font-mono text-xs">{line.sku}</TableCell>
                      <TableCell>{line.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{number(line.quantity)}</TableCell>
                      <TableCell>{line.uom}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(line.unitPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(line.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        </div>
        <div className="min-w-0 space-y-4 lg:self-start">
          <section className="space-y-1 rounded-lg border border-border bg-card p-4" data-testid="snapshot-net-price">
            <p className="text-xs uppercase text-muted-foreground">
              {t('product_configurator.snapshot.netPrice', 'Configured net price ({currency})', { currency: snapshot.currencyCode })}
            </p>
            <p className="text-2xl font-semibold tabular-nums">{money(snapshot.netPrice)}</p>
            <p className="text-xs text-muted-foreground">{t('product_configurator.snapshot.netPriceNote', 'Before quote discounts and tax.')}</p>
          </section>
          {snapshot.summary ? (
            <Section title={t('product_configurator.snapshot.sections.summary', 'Summary on the quote line')} testId="snapshot-summary">
              <p className="text-sm">{snapshot.summary}</p>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
