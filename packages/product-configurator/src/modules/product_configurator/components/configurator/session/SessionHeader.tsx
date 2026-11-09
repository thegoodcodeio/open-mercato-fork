"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { QUOTES_LIST_HREF, quoteHref, type SessionDetail } from './sessionApi'

type SessionHeaderProps = {
  session: SessionDetail
  actions?: React.ReactNode
}

/** Model title with the quote number, customer and model version; "Back to quote" keeps the session. */
export function SessionHeader({ session, actions }: SessionHeaderProps) {
  const t = useT()
  const parts = [
    session.quote?.number ? t('product_configurator.configurator.header.quote', 'Quote {number}', { number: session.quote.number }) : null,
    session.quote?.customerName ?? null,
    session.modelVersion.version !== null
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
      title={session.modelVersion.modelTitle ?? t('product_configurator.configurator.header.untitled', 'Product configuration')}
      subtitle={parts.join(' · ')}
      actionsContent={actions}
    />
  )
}
