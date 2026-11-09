"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { cn } from '@open-mercato/shared/lib/utils'
import { hasFeature } from '@open-mercato/shared/security/features'
import { emitSalesDocumentTotalsRefresh } from '@open-mercato/core/modules/sales/lib/frontend/documentTotalsEvents'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import { MODELS_LIST_HREF } from '../models/modelsApi'
import {
  CANCEL_API,
  HIGHLIGHT_PARAM,
  MutationBlockedError,
  SESSION_RESOURCE_KIND,
  SESSIONS_API,
  configureHref,
  runGuardedCall,
} from '../configurator/session/sessionApi'
import {
  OrganizationRequiredError,
  SNAPSHOTS_API,
  isOrganizationRequired,
  snapshotHref,
  snapshotListSchema,
  type SnapshotReadModel,
} from '../snapshots/snapshotsApi'
import { LineDetailsDialog } from './LineDetailsDialog'
import { TAX_RATES_FEATURE } from './lineDetailsApi'
import { ModelPickerDialog } from './ModelPickerDialog'
import {
  MODELS_VIEW_FEATURE,
  QUOTES_MANAGE_FEATURE,
  SESSIONS_MANAGE_FEATURE,
  candidatesUrl,
  openOutcomeFromResponse,
  parseCandidates,
  parseSessions,
  sessionsUrl,
  type ModelCandidate,
  type SessionListItem,
} from './quoteTabApi'

type TabData = {
  snapshots: SnapshotReadModel[]
  /** The quote has more configurations than `GET /snapshots` lists. */
  snapshotsTruncated: boolean
  sessions: SessionListItem[]
  /** `null` when the user cannot configure, so no model list is loaded. */
  candidates: ModelCandidate[] | null
}

type TabLoad = { status: 'loading' } | { status: 'error' } | { status: 'organization_required' } | { status: 'ready'; data: TabData }

type QuoteTabMutationContext = { formId: string; resourceKind: string; resourceId: string; retryLastMutation: () => Promise<boolean> }

const JSON_HEADERS = { 'content-type': 'application/json' }

async function readJson(url: string): Promise<unknown> {
  const call = await apiCall<unknown>(url, { cache: 'no-store' })
  if (isOrganizationRequired(call.status, call.result)) throw new OrganizationRequiredError()
  if (!call.ok) throw new Error(`[internal] ${url} answered ${call.status}`)
  return call.result
}

async function loadTab(quoteId: string, currencyCode: string, access: { sessions: boolean; configure: boolean }): Promise<TabData> {
  const [snapshotsPayload, sessionsPayload, candidatesPayload] = await Promise.all([
    readJson(`${SNAPSHOTS_API}?quoteId=${encodeURIComponent(quoteId)}`),
    access.sessions ? readJson(sessionsUrl(quoteId)) : Promise.resolve({ items: [] }),
    access.configure ? readJson(candidatesUrl(currencyCode)) : Promise.resolve(null),
  ])
  const snapshots = snapshotListSchema.safeParse(snapshotsPayload)
  const sessions = parseSessions(sessionsPayload)
  const candidates = candidatesPayload === null ? null : parseCandidates(candidatesPayload)
  if (!snapshots.success || !sessions || (access.configure && !candidates)) throw new Error('[internal] unexpected configurations tab payload')
  return { snapshots: snapshots.data.items, snapshotsTruncated: snapshots.data.truncated === true, sessions, candidates }
}

type QuoteConfigurationsTabProps = {
  quoteId: string
  currencyCode: string
  /** Quote `updatedAt` from the sales page, the lock token of "Edit line details". */
  quoteUpdatedAt: string | null
}

/**
 * Quote tab "Configurations": start a configuration, continue or discard one in progress, and work with the
 * configured lines (details, edit line details, add another identical, configure again a removed line).
 */
export function QuoteConfigurationsTab({ quoteId, currencyCode, quoteUpdatedAt }: QuoteConfigurationsTabProps) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const searchParams = useSearchParams()
  const highlightId = searchParams?.get(HIGHLIGHT_PARAM) ?? null
  const { payload: chrome, isReady: chromeReady } = useBackendChrome()
  const canManageSessions = hasFeature(chrome?.grantedFeatures, SESSIONS_MANAGE_FEATURE)
  const canOpenModels = hasFeature(chrome?.grantedFeatures, MODELS_VIEW_FEATURE)
  const canConfigure = canManageSessions && canOpenModels
  const canChangeLines = canManageSessions && hasFeature(chrome?.grantedFeatures, QUOTES_MANAGE_FEATURE)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const contextId = `product_configurator.quote-tab:${quoteId}`
  const { runMutation, retryLastMutation } = useGuardedMutation<QuoteTabMutationContext>({
    contextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })
  const [load, setLoad] = React.useState<TabLoad>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<{ lineId: string } | null>(null)
  const [lockToken, setLockToken] = React.useState(quoteUpdatedAt)
  const highlightRef = React.useRef<HTMLElement | null>(null)
  const scopeVersion = useOrganizationScopeVersion()
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    setLockToken(quoteUpdatedAt)
  }, [quoteUpdatedAt])

  const refreshQuote = React.useCallback(() => {
    emitSalesDocumentTotalsRefresh({ documentId: quoteId, kind: 'quote' })
    reload()
  }, [quoteId, reload])

  React.useEffect(() => {
    if (!chromeReady) return
    let cancelled = false
    setLoad((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    loadTab(quoteId, currencyCode, { sessions: canManageSessions, configure: canConfigure }).then(
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
  }, [canConfigure, canManageSessions, chromeReady, currencyCode, quoteId, reloadToken, scopeVersion])

  const highlightedPresent = load.status === 'ready' && load.data.snapshots.some((snapshot) => snapshot.id === highlightId)
  React.useEffect(() => {
    if (!highlightedPresent) return
    highlightRef.current?.scrollIntoView({ block: 'center' })
    highlightRef.current?.focus()
  }, [highlightedPresent])

  const post = (url: string, body: Record<string, unknown>, resourceId: string) =>
    runGuardedCall(
      (operation) =>
        runMutation({
          operation,
          context: { formId: contextId, resourceKind: SESSION_RESOURCE_KIND, resourceId, retryLastMutation },
          mutationPayload: body,
        }),
      () => apiCall<unknown>(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
    )

  const failureFlash = (error: unknown, fallback: string) =>
    flash(error instanceof MutationBlockedError && error.message ? error.message : fallback, 'error')

  /** Opens a new configuration (`modelId`) or a re-priced copy of a configured line (`fromSnapshotId`). */
  const openSession = async (source: { modelId: string } | { fromSnapshotId: string }) => {
    const copy = 'fromSnapshotId' in source
    setBusy(true)
    setNotice(null)
    try {
      const response = await post(SESSIONS_API, { quoteId, ...source }, quoteId)
      const outcome = openOutcomeFromResponse(response.status, response.result)
      if (outcome.kind === 'opened') {
        router.push(configureHref(outcome.sessionId))
        return
      }
      setPickerOpen(false)
      if (outcome.kind === 'not_offered' || outcome.kind === 'model_required') {
        setNotice(
          copy
            ? t(
                'product_configurator.quoteTab.copyNotOffered',
                'This configuration cannot be copied: its model was deleted, has no published version or uses another currency than the quote.',
              )
            : t(
                'product_configurator.quoteTab.notOffered',
                'This model is no longer offered for this quote: it has no published version or uses another currency. The list of models was reloaded.',
              ),
        )
        reload()
        return
      }
      const messages = {
        organization_required: t('product_configurator.quoteTab.organizationRequired', 'Select one organization in the top bar to configure a product.'),
        forbidden: t('product_configurator.quoteTab.forbidden', 'You do not have permission to configure products on this quote.'),
        error: t('product_configurator.quoteTab.openFailed', 'Could not start the configuration. Try again.'),
      }
      flash(outcome.kind === 'error' ? (outcome.message ?? messages.error) : messages[outcome.kind], 'error')
    } catch (error) {
      failureFlash(error, t('product_configurator.quoteTab.openFailed', 'Could not start the configuration. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const discardSession = async (sessionId: string) => {
    const confirmed = await confirm({
      title: t('product_configurator.configurator.discard.title', 'Discard this configuration?'),
      text: t('product_configurator.configurator.discard.text', 'The choices are deleted and nothing is added to the quote.'),
      confirmText: t('product_configurator.configurator.discard.confirm', 'Discard configuration'),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      const response = await post(CANCEL_API, { id: sessionId }, sessionId)
      if (response.ok) flash(t('product_configurator.configurator.discard.done', 'Configuration discarded. Nothing was added to the quote.'), 'success')
      else if (response.status === 409) flash(t('product_configurator.quoteTab.discardNotOpen', 'This configuration was already added or discarded in another window.'), 'info')
      else flash(t('product_configurator.configurator.discard.failed', 'Could not discard the configuration. Try again.'), 'error')
    } catch (error) {
      failureFlash(error, t('product_configurator.configurator.discard.failed', 'Could not discard the configuration. Try again.'))
    }
    reload()
  }

  if (load.status === 'loading') return <LoadingMessage label={t('product_configurator.quoteTab.loading', 'Loading configurations...')} />
  if (load.status === 'organization_required') {
    return <ErrorMessage label={t('product_configurator.quoteTab.organizationRequired', 'Select one organization in the top bar to configure a product.')} />
  }
  if (load.status === 'error') {
    return (
      <ErrorMessage
        label={t('product_configurator.quoteTab.loadFailed', 'Could not load the configurations of this quote.')}
        action={
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t('product_configurator.configurator.retry', 'Retry')}
          </Button>
        }
      />
    )
  }

  const { snapshots, snapshotsTruncated, sessions, candidates } = load.data
  const nothingFits = candidates?.length === 0
  const [adminsBefore, adminsAfter = ''] = t('product_configurator.quoteTab.adminsPublishHint', 'Admins can publish one: {link}').split('{link}')
  const dateTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  const sessionTitle = (session: SessionListItem) => {
    const title = session.modelVersion.modelTitle ?? t('product_configurator.configurator.header.untitled', 'Product configuration')
    if (!session.sourceSnapshotId) return title
    const source = snapshots.find((snapshot) => snapshot.id === session.sourceSnapshotId)
    return t('product_configurator.configurator.header.copyOf', 'Copy of: {name}', { name: source?.lineName ?? source?.modelTitle ?? title })
  }
  const configure = () => {
    if (!candidates?.length) return
    if (candidates.length === 1) void openSession({ modelId: candidates[0].id })
    else setPickerOpen(true)
  }

  return (
    <div className="space-y-6" data-testid="quote-configurations-tab">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('product_configurator.quoteTab.configuredTitle', 'Configured products')}</h3>
          {candidates && candidates.length > 0 ? (
            <Button type="button" size="sm" disabled={busy} onClick={configure} data-testid="quote-configure-product">
              {t('product_configurator.quoteTab.configure', 'Configure product')}
            </Button>
          ) : null}
        </div>
        {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
        {nothingFits ? (
          <div data-testid="quote-configure-nothing-fits">
            <EmptyState
              size="sm"
              title={t('product_configurator.quoteTab.nothingFits', 'No published model uses {currency}, so nothing can be configured on this quote.', { currency: currencyCode })}
            >
              {canOpenModels ? (
                <p className="text-sm text-muted-foreground">
                  {adminsBefore}
                  <Link href={MODELS_LIST_HREF} className="text-primary underline-offset-4 hover:underline">
                    {t('product_configurator.quoteTab.openModels', 'Open models')}
                  </Link>
                  {adminsAfter}
                </p>
              ) : null}
            </EmptyState>
          </div>
        ) : null}
        {snapshots.length === 0 ? (
          nothingFits ? null : (
            <TabEmptyState
              title={t('product_configurator.quoteTab.emptyTitle', 'No configured products yet')}
              description={t('product_configurator.quoteTab.emptyText', 'Configured products added to this quote are listed here.')}
            />
          )
        ) : (
          <>
            {canChangeLines && snapshots.some((snapshot) => snapshot.lineState === 'present') ? (
              <p className="text-sm text-muted-foreground" data-testid="quote-configurations-change-hint">
                {t(
                  'product_configurator.quoteTab.changeHint',
                  'To change a configured product, add a changed copy with Add another identical, re-enter the name (if renamed), comment, discount and a changed tax rate in Edit line details, then remove the old line in Items before sending or converting the quote.',
                )}
              </p>
            ) : null}
            <ul className="space-y-3">
              {snapshots.map((snapshot) => {
                const highlighted = snapshot.id === highlightId
                return (
                  <li
                    key={snapshot.id}
                    ref={highlighted ? (element) => { highlightRef.current = element } : undefined}
                    tabIndex={highlighted ? -1 : undefined}
                    className={cn('rounded-lg border border-border bg-card p-4 outline-none', highlighted && 'shadow-focus')}
                    data-testid={`quote-configured-line-${snapshot.id}`}
                    data-highlighted={highlighted ? 'true' : undefined}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{snapshot.lineName ?? snapshot.modelTitle}</p>
                          {snapshot.lineState === 'removed' ? (
                            <StatusBadge variant="warning" dot>
                              {t('product_configurator.snapshot.lineRemoved', 'Line removed')}
                            </StatusBadge>
                          ) : (
                            <StatusBadge variant={highlighted ? 'info' : 'success'} dot>
                              {highlighted ? t('product_configurator.quoteTab.new', 'New') : t('product_configurator.snapshot.onQuote', 'On quote')}
                            </StatusBadge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{snapshot.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            snapshot.modelVersion.version !== null ? t('product_configurator.quoteTab.version', 'v{version}', { version: snapshot.modelVersion.version }) : null,
                            dateTime(snapshot.createdAt),
                            snapshot.lineState === 'removed' ? t('product_configurator.quoteTab.lineRemovedHint', 'the line was deleted in Items') : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                          <Link
                            href={snapshotHref(snapshot.id, { kind: 'quote', id: quoteId })}
                            className="text-sm text-primary underline-offset-4 hover:underline"
                          >
                            {t('product_configurator.snapshot.pageTitle', 'Configuration details')}
                          </Link>
                          {snapshot.lineState === 'present' && canChangeLines && snapshot.lineId ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setEditing({ lineId: snapshot.lineId ?? '' })}
                              data-testid={`quote-edit-line-${snapshot.id}`}
                            >
                              {t('product_configurator.quoteTab.editLine', 'Edit line details')}
                            </Button>
                          ) : null}
                          {canChangeLines ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void openSession({ fromSnapshotId: snapshot.id })}
                              data-testid={`quote-copy-line-${snapshot.id}`}
                            >
                              {snapshot.lineState === 'removed'
                                ? t('product_configurator.quoteTab.configureAgain', 'Configure again')
                                : t('product_configurator.quoteTab.addIdentical', 'Add another identical')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold tabular-nums">{formatCurrency(snapshot.netPrice, snapshot.currencyCode, locale) ?? snapshot.netPrice}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('product_configurator.quoteTab.netPriceNote', 'Configured net price, before quote discounts')}
                        </p>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        {snapshotsTruncated ? (
          <p className="text-sm text-muted-foreground" role="status" data-testid="quote-configurations-truncated">
            {t(
              'product_configurator.quoteTab.truncated',
              'This quote has more configured products than this list can show. Only the oldest {count} are listed here; all lines are in Items.',
              { count: snapshots.length },
            )}
          </p>
        ) : null}
      </section>
      {sessions.length > 0 ? (
        <section className="space-y-3" data-testid="quote-configurations-in-progress">
          <h3 className="text-sm font-semibold">{t('product_configurator.quoteTab.inProgressTitle', 'Configurations in progress')}</h3>
          <ul className="space-y-2">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                data-testid={`quote-session-${session.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {sessionTitle(session)}
                    {session.modelVersion.version !== null ? (
                      <span className="text-muted-foreground"> · {t('product_configurator.quoteTab.version', 'v{version}', { version: session.modelVersion.version })}</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.createdBy?.displayName
                      ? t('product_configurator.quoteTab.startedBy', 'Started by {name}, {date}', { name: session.createdBy.displayName, date: dateTime(session.createdAt) })
                      : t('product_configurator.quoteTab.startedAt', 'Started {date}', { date: dateTime(session.createdAt) })}
                  </p>
                </div>
                <div className="flex gap-2">
                  {session.status === 'open' ? (
                    <Button type="button" variant="destructive-outline" size="sm" onClick={() => void discardSession(session.id)}>
                      {t('product_configurator.quoteTab.discard', 'Discard')}
                    </Button>
                  ) : null}
                  <Button asChild type="button" size="sm">
                    <Link href={configureHref(session.id)}>{t('product_configurator.quoteTab.continue', 'Continue')}</Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {candidates ? (
        <ModelPickerDialog
          open={pickerOpen}
          candidates={candidates}
          currencyCode={currencyCode}
          busy={busy}
          onCancel={() => setPickerOpen(false)}
          onStart={(modelId) => void openSession({ modelId })}
        />
      ) : null}
      {editing ? (
        <LineDetailsDialog
          quoteId={quoteId}
          lineId={editing.lineId}
          currencyCode={currencyCode}
          canReadTaxRates={hasFeature(chrome?.grantedFeatures, TAX_RATES_FEATURE)}
          lockToken={lockToken}
          onClose={() => setEditing(null)}
          onSaved={(updatedAt) => {
            setEditing(null)
            if (updatedAt) setLockToken(updatedAt)
            refreshQuote()
          }}
          onConflict={refreshQuote}
        />
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
