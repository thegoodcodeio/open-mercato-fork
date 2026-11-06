"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { pluralLabel } from '../studio/pluralLabel'
import { OrganizationRequiredError, documentSnapshotsUrl, readConfiguredLineMarkers, readSnapshotList } from '../snapshots/snapshotsApi'
import { QUOTE_TAB_WIDGET_ID } from './quoteTabApi'

type NoticeLoad = { status: 'loading' } | { status: 'hidden' } | { status: 'error' } | { status: 'ready'; count: number }

/**
 * Configured lines still on the quote. A truncated snapshot list is not complete, so the count is then
 * taken from the configuration markers on the quote lines.
 */
async function countConfiguredLines(quoteId: string): Promise<number> {
  const list = await readSnapshotList(documentSnapshotsUrl({ kind: 'quote', id: quoteId }))
  if (!list.truncated) return list.items.filter((snapshot) => snapshot.lineState === 'present').length
  const markers = await readConfiguredLineMarkers({ kind: 'quote', id: quoteId })
  return new Set(markers.values()).size
}

function findConfigurationsTabButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tab-id="${QUOTE_TAB_WIDGET_ID}"]`)
}

/**
 * Opens the Configurations tab by its tab button: the sales page has no URL parameter that opens a tab (Q5),
 * and its tab buttons carry `data-tab-id` with the widget id.
 */
function openConfigurationsTab() {
  const button = findConfigurationsTabButton()
  if (!button) return
  button.click()
  button.scrollIntoView({ block: 'start', behavior: 'smooth' })
  button.focus()
}

/** Whether the Configurations tab button is on the page; the tabs may render after the notice or go away. */
function useConfigurationsTabPresent(enabled: boolean): boolean {
  const [present, setPresent] = React.useState(false)
  React.useLayoutEffect(() => {
    if (!enabled) return
    const update = () => setPresent(findConfigurationsTabButton() !== null)
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [enabled])
  return present
}

type NoticeProps = { quoteId: string; quoteUpdatedAt: string | null }

/**
 * Shown below the quote totals (`sales.document.detail.quote:details`) when the quote has configured lines: the
 * standard Items dialog cannot save them, so it says where their name, comment, discount and tax are edited.
 * `quoteUpdatedAt` changes after every line write, which reloads the count. Nothing is shown while all
 * organizations are selected; a change of the organization selection starts over, because the sales page
 * keeps its widgets mounted.
 */
export function ConfiguredLinesNotice(props: NoticeProps) {
  const scopeVersion = useOrganizationScopeVersion()
  return <QuoteConfiguredLinesNotice key={scopeVersion} {...props} />
}

function QuoteConfiguredLinesNotice({ quoteId, quoteUpdatedAt }: NoticeProps) {
  const t = useT()
  const locale = useLocale()
  const [load, setLoad] = React.useState<NoticeLoad>({ status: 'loading' })
  const tabPresent = useConfigurationsTabPresent(load.status === 'ready' && load.count > 0)

  React.useEffect(() => {
    let cancelled = false
    countConfiguredLines(quoteId).then(
      (count) => {
        if (!cancelled) setLoad({ status: 'ready', count })
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: error instanceof OrganizationRequiredError ? 'hidden' : 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [quoteId, quoteUpdatedAt])

  if (load.status === 'loading' || load.status === 'hidden') return null
  if (load.status === 'error') {
    return <ErrorMessage label={t('product_configurator.quoteNotice.loadFailed', 'Could not check this quote for configured lines.')} />
  }
  if (load.count === 0) return null
  const text = pluralLabel(
    t,
    locale,
    'product_configurator.quoteNotice.text',
    'This quote has {count} configured lines. Edit their name, comment, discount and tax in the {link}.',
    load.count,
  )
  const [before, after = ''] = text.split('{link}')
  const linkLabel = t('product_configurator.quoteNotice.link', 'Configurations tab')
  return (
    <Alert status="information" data-testid="quote-configured-lines-notice">
      <AlertDescription>
        {before}
        {tabPresent ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0 align-baseline" onClick={openConfigurationsTab}>
            {linkLabel}
          </Button>
        ) : (
          linkLabel
        )}
        {after}
      </AlertDescription>
    </Alert>
  )
}
