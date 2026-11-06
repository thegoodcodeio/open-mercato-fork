"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { flash, type FlashKind } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert, AlertDescription, type AlertStatus } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FinaliseOutcomePanel, describeOutcome } from './FinaliseOutcomePanel'
import { SessionHeader } from './SessionHeader'
import { SessionWorkspace } from './SessionWorkspace'
import {
  FINALISE_API,
  MutationBlockedError,
  QUOTES_LIST_HREF,
  SESSION_RESOURCE_KIND,
  SESSIONS_API,
  finaliseOutcomeFromResponse,
  migrationChanges,
  quoteHref,
  runGuardedCall,
  sessionLoadFromResponse,
  type PanelOutcome,
  type SessionDetail,
  type SessionLoad,
} from './sessionApi'

type SessionConfiguratorProps = { sessionId: string }

/** Configure page island: loads the session, then the workspace for an open session or the state of a finished one. */
export function SessionConfigurator({ sessionId }: SessionConfiguratorProps) {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [load, setLoad] = React.useState<SessionLoad | { status: 'loading' }>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    void apiCall<unknown>(`${SESSIONS_API}?id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' }).then(
      (call) => {
        if (!cancelled) setLoad(sessionLoadFromResponse(call.status, call.result))
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, scopeVersion, reloadToken])

  switch (load.status) {
    case 'loading':
      return <LoadingMessage label={t('product_configurator.configurator.session.loading', 'Loading the configuration...')} />
    case 'not_found':
      return (
        <RecordNotFoundState
          label={t('product_configurator.configurator.session.notFound', 'This configuration was not found.')}
          backHref={QUOTES_LIST_HREF}
          backLabel={t('product_configurator.configurator.goToQuotes', 'Go to quotes')}
        />
      )
    case 'forbidden':
      return <ErrorMessage label={t('product_configurator.configurator.failure.forbidden', 'You do not have access to this configuration.')} />
    case 'organization_required':
      return (
        <ErrorMessage
          label={t('product_configurator.configurator.session.organizationRequired', 'Select one organization in the top bar to open this configuration.')}
        />
      )
    case 'error':
      return (
        <ErrorMessage
          label={t('product_configurator.configurator.session.loadFailed', 'Could not load the configuration.')}
          action={
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              {t('product_configurator.configurator.retry', 'Retry')}
            </Button>
          }
        />
      )
    case 'ready':
      return <ReadySession session={load.session} onReload={reload} />
  }
}

function ReadySession({ session, onReload }: { session: SessionDetail; onReload: () => void }) {
  const t = useT()
  if (session.status === 'open' && session.quote) return <SessionWorkspace key={session.id} session={session} onSessionMoved={onReload} />
  if (session.status === 'finalising') return <FinalisingSession session={session} onReload={onReload} />

  const finished = session.status === 'finalised'
  if (!session.quote && !finished) {
    return (
      <div className="space-y-4" data-testid="configurator-session-closed">
        <SessionHeader session={session} />
        <FinaliseOutcomePanel
          outcome={{ kind: 'quote_converted' }}
          definition={session.modelVersion.definition}
          priceChange={null}
          quoteId={session.quoteId}
          addDisabled
          onAction={() => undefined}
        />
      </div>
    )
  }
  return (
    <div className="space-y-4" data-testid="configurator-session-closed">
      <SessionHeader session={session} />
      <Alert status={finished ? 'success' : 'information'}>
        <AlertDescription>
          <p>
            {finished
              ? t('product_configurator.configurator.session.finalised', 'This configuration was added to the quote.')
              : t('product_configurator.configurator.session.cancelled', 'This configuration was discarded. Nothing was added to the quote.')}
          </p>
          <Button asChild type="button" variant="outline" size="sm" className="mt-2">
            {session.quote ? (
              <Link href={quoteHref(session.quoteId)}>{t('product_configurator.configurator.openQuote', 'Open the quote')}</Link>
            ) : (
              <Link href={QUOTES_LIST_HREF}>{t('product_configurator.configurator.goToQuotes', 'Go to quotes')}</Link>
            )}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}

/** Outcomes after which the session is still `finalising`; any other answer means the server moved it on. */
const STILL_FINALISING: ReadonlyArray<PanelOutcome['kind']> = ['in_progress', 'busy', 'transient']

const FLASH_KIND: Record<AlertStatus, FlashKind> = { error: 'error', warning: 'warning', information: 'info', success: 'success', feature: 'info' }

/**
 * A session left in `finalising` (an add that did not finish, for example after a crash). A copy reaches
 * `finalising` only after its rep acknowledged the changed choices, so the retry acknowledges them again. "Add to quote" runs
 * finalise again, which first adopts a line already written for it, so no second line is ever created. When the
 * server answers that the session moved on (reopened, cancelled, finalised elsewhere), the page reloads it.
 */
function FinalisingSession({ session, onReload }: { session: SessionDetail; onReload: () => void }) {
  const t = useT()
  const router = useRouter()
  const contextId = `product_configurator.session:${session.id}`
  const { runMutation, retryLastMutation } = useGuardedMutation<Record<string, unknown>>({
    contextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })
  const [busy, setBusy] = React.useState(false)
  const [outcome, setOutcome] = React.useState<PanelOutcome | null>(null)
  const hash = session.evaluation?.hash ?? null

  const finish = async () => {
    if (!hash) return
    const body = {
      id: session.id,
      expectedHash: hash,
      revision: session.revision,
      ...(migrationChanges(session.migration).length > 0 ? { migrationAcknowledged: true } : {}),
    }
    setBusy(true)
    try {
      const response = await runGuardedCall(
        (operation) =>
          runMutation({
            operation,
            context: { formId: contextId, resourceKind: SESSION_RESOURCE_KIND, resourceId: session.id, retryLastMutation },
            mutationPayload: body,
          }),
        () => apiCall<unknown>(FINALISE_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      )
      const next = finaliseOutcomeFromResponse(response.status, response.result)
      if (next.kind === 'added') {
        flash(
          next.replay
            ? t('product_configurator.configurator.finalise.replay', 'This configuration was already added to the quote in another window. The line is on the quote.')
            : t('product_configurator.configurator.session.finalised', 'This configuration was added to the quote.'),
          next.replay ? 'info' : 'success',
        )
        router.push(quoteHref(session.quoteId, next.snapshotId))
        return
      }
      if (next.kind === 'added_with_earlier_choices') {
        const view = describeOutcome(next, { definition: session.modelVersion.definition, priceChange: null, t })
        flash(view.text, FLASH_KIND[view.status])
        router.push(quoteHref(session.quoteId, next.snapshotId))
        return
      }
      if (next.kind === 'session_changed' || next.kind === 'migration_unconfirmed') return onReload()
      if (STILL_FINALISING.includes(next.kind)) return setOutcome(next)
      const view = describeOutcome(next, { definition: session.modelVersion.definition, priceChange: null, t })
      flash(view.text, FLASH_KIND[view.status])
      onReload()
    } catch (error) {
      setOutcome(error instanceof MutationBlockedError ? { kind: 'other', message: error.message || null } : { kind: 'transient' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="configurator-session-finalising">
      <SessionHeader session={session} />
      <Alert status="information">
        <AlertDescription>
          <p>{t('product_configurator.configurator.session.finalising', 'This configuration is being added to the quote. If it does not finish, add it again; no second line is created.')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              {t('product_configurator.configurator.session.checkAgain', 'Check again')}
            </Button>
            {hash ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void finish()}>
                {t('product_configurator.configurator.addToQuote', 'Add to quote')}
              </Button>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
      {outcome ? (
        <FinaliseOutcomePanel
          outcome={outcome}
          definition={session.modelVersion.definition}
          priceChange={null}
          quoteId={session.quoteId}
          addDisabled={busy}
          onAction={(action) => (action === 'retry' ? void finish() : setOutcome(null))}
        />
      ) : null}
    </div>
  )
}
