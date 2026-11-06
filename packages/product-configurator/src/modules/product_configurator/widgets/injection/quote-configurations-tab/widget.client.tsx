"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { QuoteConfigurationsTab } from '../../../components/quote/QuoteConfigurationsTab'
import { quoteTabContextSchema } from '../../../components/quote/quoteTabApi'

export default function QuoteConfigurationsTabWidget({ context }: InjectionWidgetComponentProps) {
  const parsed = quoteTabContextSchema.safeParse(context)
  if (!parsed.success || parsed.data.kind !== 'quote') return null
  const quoteId = parsed.data.documentId ?? parsed.data.record?.id ?? null
  const currencyCode = parsed.data.record?.currencyCode ?? null
  if (!quoteId || !currencyCode) return null
  return <QuoteConfigurationsTab quoteId={quoteId} currencyCode={currencyCode} quoteUpdatedAt={parsed.data.record?.updatedAt ?? null} />
}
