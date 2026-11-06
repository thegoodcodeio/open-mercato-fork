"use client"

import * as React from 'react'
import { useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { QUOTES_LIST_HREF, quoteHref, type SessionDetail } from './sessionApi'

type SessionHeaderProps = {
  session: SessionDetail
  actions?: React.ReactNode
}

/** The header title: the model, or "Copy of: <line name>" for a copy (the model title when the line is gone). */
export function sessionTitle(session: SessionDetail, t: TranslateFn): string {
  const modelTitle = session.modelVersion.modelTitle ?? t('product_configurator.configurator.header.untitled', 'Product configuration')
  if (!session.sourceSnapshotId) return modelTitle
  return t('product_configurator.configurator.header.copyOf', 'Copy of: {name}', { name: session.sourceLineName ?? modelTitle })
}

/** Model title (or the copy source) with the quote number, customer and model version; "Back to quote" keeps the session. */
export function SessionHeader({ session, actions }: SessionHeaderProps) {
  const t = useT()
  const migration = session.migration
  const parts = [
    session.quote?.number ? t('product_configurator.configurator.header.quote', 'Quote {number}', { number: session.quote.number }) : null,
    session.quote?.customerName ?? null,
    migration
      ? t('product_configurator.configurator.header.copiedFrom', 'copied from model v{from}, now v{to}', {
          from: migration.fromVersion.version,
          to: migration.toVersion.version,
        })
      : session.modelVersion.version !== null
        ? t('product_configurator.configurator.header.version', 'Model v{version}', { version: session.modelVersion.version })
        : null,
  ].filter((part): part is string => Boolean(part))

  return (
    <FormHeader
      mode="detail"
      backHref={session.quote ? quoteHref(session.quoteId) : QUOTES_LIST_HREF}
      backLabel={
        session.quote
          ? t('product_configurator.configurator.backToQuote', 'Back to quote')
          : t('product_configurator.configurator.goToQuotes', 'Go to quotes')
      }
      entityTypeLabel={t('product_configurator.configurator.header.entityType', 'Configure product')}
      title={sessionTitle(session, t)}
      subtitle={parts.join(' · ')}
      actionsContent={actions}
    />
  )
}
