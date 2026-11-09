"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { LinkButton } from '@open-mercato/ui/primitives/link-button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import { anyName } from './names'
import { pluralLabel } from './pluralLabel'
import type { StudioReport } from './studioState'
import { issueTargets, type StudioRefTarget } from './studioRefs'
import { STUDIO_TABS } from './tabs/registry'
import type { StudioDefinition, StudioTabId } from './tabs/types'
import { issueCheckLabel, issueMessage } from './validationMessages'

type ValidationReportPanelProps = {
  report: StudioReport
  /** The saved draft the report was made for; names and row links resolve against it. */
  definition: StudioDefinition | null
  dirty: boolean
  onNavigate: (tab: StudioTabId, key: string | null) => void
  onDismiss: () => void
}

function tabLabel(tab: StudioTabId, t: ReturnType<typeof useT>): string {
  const entry = STUDIO_TABS.find((candidate) => candidate.id === tab)
  return entry ? t(entry.labelKey, entry.fallbackLabel) : tab
}

function targetLabel(target: StudioRefTarget, definition: StudioDefinition | null, t: ReturnType<typeof useT>): string {
  const tab = tabLabel(target.tab, t)
  return target.key ? `${tab} › ${anyName(definition, target.key)}` : tab
}

const PROBLEM_COUNT_KEYS: Record<StudioReport['source'], { base: string; fallback: string }> = {
  publish: { base: 'product_configurator.studio.report.cannotPublishCount', fallback: 'Cannot publish: {count} problems' },
  validate: { base: 'product_configurator.studio.report.problemsCount', fallback: '{count} problems found' },
}

function problemCountTitle(source: StudioReport['source'], count: number, locale: string, t: ReturnType<typeof useT>): string {
  const { base, fallback } = PROBLEM_COUNT_KEYS[source]
  return pluralLabel(t, locale, base, fallback, count)
}

export function ValidationReportPanel({ report, definition, dirty, onNavigate, onDismiss }: ValidationReportPanelProps) {
  const t = useT()
  const locale = useLocale()
  const titleId = React.useId()
  const checkedAt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.checkedAt))
  const issues = report.report.issues

  if (issues.length === 0) {
    return (
      <Alert status="success" dismissible onDismiss={onDismiss} dismissAriaLabel={t('ui.forms.conflict.dismiss', 'Dismiss')}>
        <AlertTitle>{t('product_configurator.studio.report.okTitle', 'No problems found')}</AlertTitle>
        <AlertDescription>
          {t('product_configurator.studio.report.okText', 'The saved draft passes every publication check. Checked {checkedAt}.', { checkedAt })}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby={titleId} data-testid="studio-validation-report">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          <span role="alert">{problemCountTitle(report.source, issues.length, locale, t)}</span>
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t('product_configurator.studio.report.checkedAt', 'Checked {checkedAt}, saved draft', { checkedAt })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t('ui.forms.conflict.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
      {dirty ? (
        <p className="text-sm text-muted-foreground">
          {t('product_configurator.studio.report.staleHint', 'This report is for the saved draft. Save your changes and validate again.')}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('product_configurator.studio.report.check', 'Check')}</TableHead>
            <TableHead>{t('product_configurator.studio.report.problem', 'Problem')}</TableHead>
            <TableHead>{t('product_configurator.studio.report.where', 'Where')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue, index) => (
            <TableRow key={`${issue.code}-${index}`} data-testid="studio-validation-issue">
              <TableCell className="align-top">
                <StatusBadge variant="error">{issueCheckLabel(issue, t)}</StatusBadge>
              </TableCell>
              <TableCell className="align-top text-sm">{issueMessage(issue, definition, t)}</TableCell>
              <TableCell className="align-top">
                <div className="flex flex-col items-start gap-1">
                  {issueTargets(issue, definition).map((target) => (
                    <LinkButton
                      key={`${target.tab}:${target.key ?? ''}`}
                      size="sm"
                      onClick={() => onNavigate(target.tab, target.key)}
                    >
                      {targetLabel(target, definition, t)}
                    </LinkButton>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
