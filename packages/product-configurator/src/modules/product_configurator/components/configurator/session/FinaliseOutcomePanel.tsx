"use client"

import * as React from 'react'
import Link from 'next/link'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert, AlertDescription, type AlertStatus } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import type { ConfigurationDefinition } from '../../../data/validators'
import { failureText } from '../failureMessages'
import {
  ORDERS_VIEW_FEATURE,
  QUOTES_LIST_HREF,
  convertedOrderLookupUrl,
  convertedQuoteLinkFromResponse,
  quoteHref,
  type ConvertedQuoteLink,
  type PanelOutcome,
} from './sessionApi'
import type { PriceChange } from './useSessionWorkspace'

export type OutcomeAction = 'retry' | 'confirm_price' | 'dismiss' | 'discard' | 'open_quote' | 'quotes'

type OutcomeView = { status: AlertStatus; text: string; actions: OutcomeAction[] }

/** Text and ways out per outcome; only failures that can succeed on a second try offer one. */
export function describeOutcome(
  outcome: PanelOutcome,
  input: { definition: ConfigurationDefinition; priceChange: PriceChange | null; t: TranslateFn },
): OutcomeView {
  const { t } = input
  switch (outcome.kind) {
    case 'result_changed':
      return {
        status: 'warning',
        text: input.priceChange
          ? t(
              'product_configurator.configurator.finalise.priceChanged',
              'The price changed from {from} to {to} because catalog prices were updated. Nothing was added yet.',
              { from: input.priceChange.from, to: input.priceChange.to },
            )
          : t('product_configurator.configurator.finalise.priceChangedUnknown', 'The price changed because catalog prices were updated. Nothing was added yet.'),
        actions: ['dismiss', 'confirm_price'],
      }
    case 'added_with_earlier_choices':
      return {
        status: 'warning',
        text: t(
          'product_configurator.configurator.finalise.addedWithEarlierChoices',
          'This configuration was already added to the quote with an earlier result. Your later changes were not added.',
        ),
        actions: ['open_quote'],
      }
    case 'session_not_open':
      return {
        status: 'information',
        text:
          outcome.status === 'cancelled'
            ? t('product_configurator.configurator.finalise.discardedElsewhere', 'This configuration was discarded in another window. Nothing was added.')
            : t('product_configurator.configurator.finalise.notOpen', 'This configuration was already added or discarded in another window.'),
        actions: ['open_quote'],
      }
    case 'in_progress':
      return {
        status: 'warning',
        text: t(
          'product_configurator.configurator.finalise.inProgress',
          'Another configuration is being added to this quote right now. Your choices are kept; try again in a moment.',
        ),
        actions: ['retry'],
      }
    case 'busy':
      return {
        status: 'warning',
        text: t('product_configurator.configurator.finalise.busy', 'Adding is busy right now. Nothing was added. Your choices are kept; try again in a moment.'),
        actions: ['retry'],
      }
    case 'quote_changed':
      return {
        status: 'warning',
        text: t(
          'product_configurator.configurator.finalise.quoteChanged',
          'The quote was changed by someone else while you were adding. Nothing was added. Check the quote and try again. Your choices are kept.',
        ),
        actions: ['open_quote', 'retry'],
      }
    case 'quote_converted':
      return {
        status: 'error',
        text: t(
          'product_configurator.configurator.finalise.quoteConverted',
          'This quote was converted to an order or deleted, so this configuration can no longer be added. Nothing was added. To sell it, start from a new quote.',
        ),
        actions: ['quotes'],
      }
    case 'cannot_add': {
      const reasons = {
        model_deleted: t('product_configurator.configurator.finalise.modelDeleted', 'This configuration cannot be added because its model was deleted. Nothing was added.'),
        product_missing: t(
          'product_configurator.configurator.finalise.productMissing',
          'This configuration cannot be added because the catalog product of its model no longer exists. Nothing was added.',
        ),
        currency_mismatch: t(
          'product_configurator.configurator.finalise.currencyMismatch',
          'This configuration cannot be added because the quote currency no longer matches the model currency. Nothing was added.',
        ),
      }
      return { status: 'error', text: reasons[outcome.code], actions: ['discard'] }
    }
    case 'write_failed':
      return {
        status: 'error',
        text: t('product_configurator.configurator.finalise.writeFailed', 'The line could not be added to the quote. Your choices are kept.'),
        actions: ['retry'],
      }
    case 'not_finalisable':
      return {
        status: 'error',
        text: t('product_configurator.configurator.finalise.notFinalisable', 'This configuration has blocking messages and cannot be added. Nothing was added.'),
        actions: [],
      }
    case 'evaluation':
      return {
        status: 'error',
        text:
          failureText(input.definition, outcome.failure, t) ??
          t('product_configurator.configurator.finalise.other', 'The configuration could not be added. Nothing was added.'),
        actions: [],
      }
    case 'transient':
      return {
        status: 'error',
        text: t('product_configurator.configurator.finalise.transient', 'Could not reach the server. Nothing was added. Your choices are kept.'),
        actions: ['retry'],
      }
    case 'other':
      return {
        status: 'error',
        text: outcome.message ?? t('product_configurator.configurator.finalise.other', 'The configuration could not be added. Nothing was added.'),
        actions: [],
      }
  }
}

type FinaliseOutcomePanelProps = {
  outcome: PanelOutcome
  definition: ConfigurationDefinition
  priceChange: PriceChange | null
  quoteId: string
  /** Disables the actions that add again (Try again, Add with new price): while adding, or while the workspace is not ready. */
  addDisabled: boolean
  onAction: (action: Exclude<OutcomeAction, 'open_quote' | 'quotes'>) => void
}

/** Where a rep goes from a converted quote: its order once it is found, until then (and without order access) the quotes list. */
function useConvertedQuoteLink(quoteId: string, converted: boolean): ConvertedQuoteLink {
  const { payload: chrome } = useBackendChrome()
  const canViewOrders = hasFeature(chrome?.grantedFeatures, ORDERS_VIEW_FEATURE)
  const [link, setLink] = React.useState<ConvertedQuoteLink>({ kind: 'quotes', href: QUOTES_LIST_HREF })
  React.useEffect(() => {
    if (!converted || !canViewOrders) return
    let cancelled = false
    void apiCall<unknown>(convertedOrderLookupUrl(quoteId), { cache: 'no-store', headers: { 'x-om-forbidden-redirect': '0' } }).then(
      (call) => {
        if (!cancelled) setLink(convertedQuoteLinkFromResponse(call.status, call.result, quoteId))
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [canViewOrders, converted, quoteId])
  return link
}

export function FinaliseOutcomePanel({ outcome, definition, priceChange, quoteId, addDisabled, onAction }: FinaliseOutcomePanelProps) {
  const t = useT()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const view = describeOutcome(outcome, { definition, priceChange, t })
  const convertedLink = useConvertedQuoteLink(quoteId, outcome.kind === 'quote_converted')

  React.useEffect(() => {
    panelRef.current?.focus()
  }, [outcome.kind])

  const renderAction = (action: OutcomeAction) => {
    switch (action) {
      case 'retry':
        return (
          <Button key={action} type="button" size="sm" disabled={addDisabled} onClick={() => onAction('retry')}>
            {outcome.kind === 'quote_changed'
              ? t('product_configurator.configurator.addToQuote', 'Add to quote')
              : t('product_configurator.configurator.finalise.tryAgain', 'Try again')}
          </Button>
        )
      case 'confirm_price':
        return (
          <Button key={action} type="button" size="sm" disabled={addDisabled} onClick={() => onAction('confirm_price')}>
            {t('product_configurator.configurator.finalise.addWithNewPrice', 'Add with new price')}
          </Button>
        )
      case 'dismiss':
        return (
          <Button key={action} type="button" variant="outline" size="sm" onClick={() => onAction('dismiss')}>
            {t('product_configurator.configurator.finalise.back', 'Back')}
          </Button>
        )
      case 'discard':
        return (
          <Button key={action} type="button" variant="destructive-outline" size="sm" onClick={() => onAction('discard')}>
            {t('product_configurator.configurator.discard.confirm', 'Discard configuration')}
          </Button>
        )
      case 'open_quote':
        return (
          <Button key={action} asChild type="button" variant="outline" size="sm">
            <Link href={quoteHref(quoteId, outcome.kind === 'added_with_earlier_choices' ? outcome.snapshotId : undefined)}>
              {t('product_configurator.configurator.openQuote', 'Open the quote')}
            </Link>
          </Button>
        )
      case 'quotes':
        return (
          <Button key={action} asChild type="button" variant="outline" size="sm">
            <Link href={convertedLink.href}>
              {convertedLink.kind === 'order'
                ? t('product_configurator.configurator.openOrder', 'Open the order')
                : convertedLink.kind === 'orders'
                  ? t('product_configurator.configurator.goToOrders', 'Go to orders')
                  : t('product_configurator.configurator.goToQuotes', 'Go to quotes')}
            </Link>
          </Button>
        )
    }
  }

  return (
    <div ref={panelRef} tabIndex={-1} className="outline-none" data-testid="configurator-finalise-outcome" data-outcome={outcome.kind}>
      <Alert status={view.status}>
        <AlertDescription>
          <p>{view.text}</p>
          {view.actions.length ? <div className="mt-2 flex flex-wrap gap-2">{view.actions.map(renderAction)}</div> : null}
        </AlertDescription>
      </Alert>
    </div>
  )
}
