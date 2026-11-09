"use client"

import * as React from 'react'
import Link from 'next/link'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import { OrganizationRequiredError, snapshotHref } from '../snapshots/snapshotsApi'
import { loadOrderSnapshots, type OrderSnapshots } from './orderApi'

type TabLoad = { status: 'loading' } | { status: 'error' } | { status: 'organization_required' } | { status: 'ready'; data: OrderSnapshots }

/** Order tab "Configurations": read-only list of the configured order lines with their details. */
export function OrderConfigurationsTab({ orderId }: { orderId: string }) {
  const t = useT()
  const locale = useLocale()
  const [load, setLoad] = React.useState<TabLoad>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)
  const scopeVersion = useOrganizationScopeVersion()

  React.useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    loadOrderSnapshots(orderId).then(
      (data) => {
        if (!cancelled) setLoad({ status: 'ready', data })
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: error instanceof OrganizationRequiredError ? 'organization_required' : 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [orderId, reloadToken, scopeVersion])

  if (load.status === 'loading') return <LoadingMessage label={t('product_configurator.quoteTab.loading', 'Loading configurations...')} />
  if (load.status === 'organization_required') {
    return <ErrorMessage label={t('product_configurator.orderTab.organizationRequired', 'Select one organization in the top bar to see the configurations of this order.')} />
  }
  if (load.status === 'error') {
    return (
      <ErrorMessage
        label={t('product_configurator.orderTab.loadFailed', 'Could not load the configurations of this order.')}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            {t('product_configurator.configurator.retry', 'Retry')}
          </Button>
        }
      />
    )
  }

  const { items, truncated } = load.data
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value))

  return (
    <div className="space-y-3" data-testid="order-configurations-tab">
      <h3 className="text-sm font-semibold">{t('product_configurator.quoteTab.configuredTitle', 'Configured products')}</h3>
      {items.length === 0 ? (
        <TabEmptyState
          title={t('product_configurator.orderTab.emptyTitle', 'No configured products')}
          description={t('product_configurator.orderTab.emptyText', 'Configured products on this order are listed here.')}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((snapshot) => (
            <li key={snapshot.id} className="rounded-lg border border-border bg-card p-4" data-testid={`order-configured-line-${snapshot.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{snapshot.lineName ?? snapshot.modelTitle}</p>
                  <p className="text-sm text-muted-foreground">{snapshot.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      snapshot.modelVersion.version !== null ? t('product_configurator.quoteTab.version', 'v{version}', { version: snapshot.modelVersion.version }) : null,
                      t('product_configurator.orderTab.addedAt', 'added {date}', { date: date(snapshot.createdAt) }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <Link
                    href={snapshotHref(snapshot.id, { kind: 'order', id: orderId })}
                    className="inline-block text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {t('product_configurator.snapshot.pageTitle', 'Configuration details')}
                  </Link>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">{formatCurrency(snapshot.netPrice, snapshot.currencyCode, locale) ?? snapshot.netPrice}</p>
                  <p className="text-xs text-muted-foreground">{t('product_configurator.orderTab.netPriceNote', 'Configured net price, before discounts')}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="order-configurations-truncated">
          {t(
            'product_configurator.orderTab.truncated',
            'This order has more configured products than this list can show. Only the oldest {count} are listed here; all lines are in Items.',
            { count: items.length },
          )}
        </p>
      ) : null}
    </div>
  )
}
