"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { ConfiguredLinesNotice } from '../../../components/quote/ConfiguredLinesNotice'
import { quoteTabContextSchema } from '../../../components/quote/quoteTabApi'

export default function QuoteConfiguredLinesNoticeWidget({ context }: InjectionWidgetComponentProps) {
  const parsed = quoteTabContextSchema.safeParse(context)
  if (!parsed.success || parsed.data.kind !== 'quote') return null
  const quoteId = parsed.data.documentId ?? parsed.data.record?.id ?? null
  if (!quoteId) return null
  return <ConfiguredLinesNotice quoteId={quoteId} quoteUpdatedAt={parsed.data.record?.updatedAt ?? null} />
}
