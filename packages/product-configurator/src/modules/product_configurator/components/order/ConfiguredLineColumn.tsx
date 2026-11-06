"use client"

import * as React from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useOrderItemsInjectionContext } from '@open-mercato/core/modules/sales/widgets/injection/order-items-context'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { OrganizationRequiredError, snapshotHref, type SnapshotReadModel } from '../snapshots/snapshotsApi'
import { loadOrderConfiguredLinesShared } from './orderApi'

type CellState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; snapshot: SnapshotReadModel | null }

/** "Configured" cell of an order items row (`getValue` is the order line id): a badge and a link to the details. */
export function ConfiguredLineCell({ getValue }: { getValue: () => unknown }) {
  const t = useT()
  const context = useOrderItemsInjectionContext()
  const value = getValue()
  const lineId = typeof value === 'string' ? value : null
  const orderId = context?.kind === 'order' ? context.documentId : null
  const [state, setState] = React.useState<CellState>({ status: 'loading' })
  const scopeVersion = useOrganizationScopeVersion()

  React.useEffect(() => {
    if (!orderId || !lineId) return
    let cancelled = false
    setState({ status: 'loading' })
    loadOrderConfiguredLinesShared(orderId, scopeVersion).then(
      (byLine) => {
        if (!cancelled) setState({ status: 'ready', snapshot: byLine.get(lineId) ?? null })
      },
      (error: unknown) => {
        if (cancelled) return
        setState(error instanceof OrganizationRequiredError ? { status: 'ready', snapshot: null } : { status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [orderId, lineId, scopeVersion])

  if (!orderId || !lineId) return null
  if (state.status === 'loading') return <Spinner size="sm" />
  if (state.status === 'error') {
    return <span className="text-xs text-muted-foreground">{t('product_configurator.orderItems.unavailable', 'Not available')}</span>
  }
  if (!state.snapshot) return null
  return (
    <div className="flex flex-col items-start gap-1" data-testid={`order-item-configured-${lineId}`}>
      <StatusBadge variant="info" dot>
        {t('product_configurator.orderItems.configured', 'Configured')}
      </StatusBadge>
      <Link
        href={snapshotHref(state.snapshot.id, { kind: 'order', id: orderId })}
        className="text-xs text-primary underline-offset-4 hover:underline"
        aria-label={t('product_configurator.orderItems.detailsFor', 'Configuration details of {name}', {
          name: state.snapshot.lineName ?? state.snapshot.modelTitle ?? '',
        })}
      >
        {t('product_configurator.orderItems.details', 'Details')}
      </Link>
    </div>
  )
}
