"use client"

import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'
import { Button } from '@open-mercato/ui/primitives/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import type { ConfigurationDefinition } from '../../data/validators'
import type { WorkspaceEvaluation } from './evaluationSchema'
import type { WorkspaceMessage } from './workspaceModel'

const SEVERITY_CLASSES: Record<WorkspaceMessage['severity'], string> = {
  error: 'border-status-error-border bg-status-error-bg text-status-error-text',
  warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
  info: 'border-border bg-muted text-foreground',
}

type ConfigurationDetailsProps = {
  definition: ConfigurationDefinition
  evaluation: WorkspaceEvaluation
  messages: WorkspaceMessage[]
  onGoToFeature: (featureKey: string) => void
  /** Extra content under the messages (the rule trace of the studio Test tab). */
  messagesFooter?: React.ReactNode
}

/** Messages that link to the fields they concern, and the collapsible bill of materials. */
export function ConfigurationDetails({ definition, evaluation, messages, onGoToFeature, messagesFooter }: ConfigurationDetailsProps) {
  const t = useT()
  const locale = useLocale()
  const [bomOpen, setBomOpen] = React.useState(true)
  const featureLabel = (key: string) => definition.features.find((feature) => feature.key === key)?.label ?? key
  const money = (value: string) => formatCurrency(value, evaluation.currencyCode, locale) ?? value
  const bomId = React.useId()

  return (
    <>
      <section className="space-y-2 rounded-lg border border-border bg-card p-4" aria-labelledby={`${bomId}-messages`} data-testid="configurator-messages">
        <h3 id={`${bomId}-messages`} className="text-sm font-semibold">
          {t('product_configurator.configurator.messages.title', 'Messages')}
        </h3>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('product_configurator.configurator.messages.empty', 'No messages for these choices.')}</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((message) => (
              <li key={message.id} className={cn('rounded-md border px-3 py-2 text-sm', SEVERITY_CLASSES[message.severity])}>
                {message.severity === 'error' ? (
                  <span className="font-semibold">{t('product_configurator.configurator.messages.blocking', 'Blocking:')} </span>
                ) : null}
                {message.text}
                {message.featureKeys.map((key) => (
                  <Button key={key} type="button" variant="link" size="sm" className="ml-1 h-auto p-0 align-baseline" onClick={() => onGoToFeature(key)}>
                    {t('product_configurator.configurator.messages.goTo', 'Go to {feature}', { feature: featureLabel(key) })}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        )}
        {messagesFooter}
      </section>
      <section className="rounded-lg border border-border bg-card p-4" data-testid="configurator-bom">
        <h3 className="text-sm font-semibold">
          <button
            type="button"
            className="flex items-center gap-1"
            aria-expanded={bomOpen}
            aria-controls={`${bomId}-bom`}
            onClick={() => setBomOpen((open) => !open)}
          >
            {bomOpen ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
            {t('product_configurator.configurator.bom.title', 'Bill of materials ({count} lines)', { count: evaluation.bom.length })}
          </button>
        </h3>
        <div id={`${bomId}-bom`} hidden={!bomOpen} className="pt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('product_configurator.configurator.bom.part', 'Part')}</TableHead>
                <TableHead className="text-right">{t('product_configurator.configurator.bom.quantity', 'Qty')}</TableHead>
                <TableHead>{t('product_configurator.configurator.bom.unit', 'Unit')}</TableHead>
                <TableHead className="text-right">{t('product_configurator.configurator.bom.unitPrice', 'Unit price')}</TableHead>
                <TableHead className="text-right">{t('product_configurator.configurator.bom.total', 'Total')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {evaluation.bom.map((line) => (
                <TableRow key={line.bomId}>
                  <TableCell>
                    <span className="block">{line.label}</span>
                    <span className="block text-xs text-muted-foreground">{line.sku}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{new Intl.NumberFormat(locale).format(Number(line.quantity))}</TableCell>
                  <TableCell>{line.uom}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(line.unitPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(line.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </>
  )
}
