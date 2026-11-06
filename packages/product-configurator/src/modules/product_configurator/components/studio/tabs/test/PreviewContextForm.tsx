"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { LookupSinglePicker } from '@open-mercato/ui/backend/inputs/LookupPickers'
import { Button } from '@open-mercato/ui/primitives/button'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import {
  REFERENCE_CONTEXT,
  customerSource,
  fromDateOnly,
  isReferenceContext,
  salesChannelSource,
  toDateOnly,
  type PreviewContext,
} from './previewApi'

type PreviewContextFormProps = {
  value: PreviewContext
  onChange: (next: PreviewContext) => void
}

/** Channel, customer and price date the saved draft is priced for, or the reference context. */
export function PreviewContextForm({ value, onChange }: PreviewContextFormProps) {
  const t = useT()
  const ids = { channel: React.useId(), customer: React.useId(), date: React.useId() }
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="preview-context">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5" data-testid="preview-context-channel">
          <span id={ids.channel} className="block text-sm font-medium">
            {t('product_configurator.studio.test.channel', 'Channel')}
          </span>
          <div role="group" aria-labelledby={ids.channel}>
            <LookupSinglePicker
              source={salesChannelSource}
              value={value.channelId ?? ''}
              clearable
              placeholder={t('product_configurator.studio.test.noChannel', 'No channel')}
              onChange={(next) => onChange({ ...value, channelId: next || null })}
            />
          </div>
        </div>
        <div className="space-y-1.5" data-testid="preview-context-customer">
          <span id={ids.customer} className="block text-sm font-medium">
            {t('product_configurator.studio.test.customer', 'Customer')}
          </span>
          <div role="group" aria-labelledby={ids.customer}>
            <LookupSinglePicker
              source={customerSource}
              value={value.customerId ?? ''}
              clearable
              placeholder={t('product_configurator.studio.test.noCustomer', 'No customer')}
              onChange={(next) => onChange({ ...value, customerId: next || null })}
            />
          </div>
        </div>
        <div className="space-y-1.5" data-testid="preview-context-date">
          <span id={ids.date} className="block text-sm font-medium">
            {t('product_configurator.studio.test.date', 'Price date')}
          </span>
          <div role="group" aria-labelledby={ids.date}>
            <DatePicker
              value={fromDateOnly(value.date)}
              footer="today-clear"
              placeholder={t('product_configurator.studio.test.today', 'Today')}
              onChange={(next) => onChange({ ...value, date: next ? toDateOnly(next) : null })}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {isReferenceContext(value) ? (
          <span data-testid="preview-reference-context">
            {t(
              'product_configurator.studio.test.referenceActive',
              'Reference context: the model price kind, no channel, no customer, today (the default customer group applies when there is one).',
            )}
          </span>
        ) : (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onChange(REFERENCE_CONTEXT)}>
            {t('product_configurator.studio.test.useReference', 'Use the reference context')}
          </Button>
        )}
      </div>
    </section>
  )
}
