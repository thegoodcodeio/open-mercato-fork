"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { OrderConfigurationsTab } from '../../../components/order/OrderConfigurationsTab'
import { orderTabContextSchema } from '../../../components/order/orderApi'

export default function OrderConfigurationsTabWidget({ context }: InjectionWidgetComponentProps) {
  const parsed = orderTabContextSchema.safeParse(context)
  if (!parsed.success || parsed.data.kind !== 'order') return null
  const orderId = parsed.data.documentId ?? parsed.data.record?.id ?? null
  if (!orderId) return null
  return <OrderConfigurationsTab orderId={orderId} />
}
