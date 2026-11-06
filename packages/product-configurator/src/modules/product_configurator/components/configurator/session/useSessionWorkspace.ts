"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import {
  sessionStateSchema,
  type EvaluateOutcome,
  type SessionState,
  type SessionStatus,
  type WorkspaceEvaluation,
  type WorkspaceSelections,
} from '../evaluationSchema'
import { useConfiguratorEvaluation } from '../useConfiguratorEvaluation'
import {
  CANCEL_API,
  EVALUATE_API,
  FINALISE_API,
  MutationBlockedError,
  SESSION_RESOURCE_KIND,
  SESSIONS_API,
  evaluateOutcomeFromResponse,
  finaliseOutcomeFromResponse,
  quoteHref,
  runGuardedCall,
  sessionLoadFromResponse,
  type PanelOutcome,
  type SessionDetail,
} from './sessionApi'

type SessionMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

/** A refused change: the current session, the rep's refused choices and the settled values the rep saw. */
export type SessionConflict = { session: SessionState; rejected: WorkspaceSelections; shown: WorkspaceSelections }

export type PriceChange = { from: string; to: string }

const JSON_HEADERS = { 'content-type': 'application/json' }

/** A request replaced by a newer change before it was sent; the evaluation hook ignores its outcome. */
const SUPERSEDED: EvaluateOutcome = { ok: false, failure: { kind: 'transient' } }

/**
 * Session mode of the configurator workspace: evaluates on the session revision, serializes evaluate calls (so
 * this window never refuses its own newer revision), resolves `session_changed`, adds the result to the quote
 * and discards the session. Evaluate, finalise and discard go through `useGuardedMutation`. `onSessionMoved`
 * reloads the page when a failed line write left the session no longer open (an uncertain write stays
 * `finalising` until the next finalise reconciles it, so this window must stop editing).
 */
export function useSessionWorkspace(session: SessionDetail, onSessionMoved: () => void) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const contextId = `product_configurator.session:${session.id}`
  const { runMutation, retryLastMutation } = useGuardedMutation<SessionMutationContext>({
    contextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })
  const mutationContext = React.useMemo<SessionMutationContext>(
    () => ({ formId: contextId, resourceKind: SESSION_RESOURCE_KIND, resourceId: session.id, retryLastMutation }),
    [contextId, retryLastMutation, session.id],
  )
  const revisionRef = React.useRef(session.revision)
  const chainRef = React.useRef<Promise<void>>(Promise.resolve())
  const callRef = React.useRef(0)

  const post = React.useCallback(
    (url: string, body: Record<string, unknown>) =>
      runGuardedCall(
        (operation) => runMutation({ operation, context: mutationContext, mutationPayload: body }),
        () => apiCall<unknown>(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
      ),
    [mutationContext, runMutation],
  )
  const postRef = React.useRef(post)
  postRef.current = post

  const evaluate = React.useCallback(
    async (selections: WorkspaceSelections): Promise<EvaluateOutcome> => {
      const call = ++callRef.current
      const previous = chainRef.current
      let release: () => void = () => undefined
      chainRef.current = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await previous
        if (call !== callRef.current) return SUPERSEDED
        const response = await postRef.current(EVALUATE_API, { id: session.id, revision: revisionRef.current, selections })
        const outcome = evaluateOutcomeFromResponse(response.status, response.result, selections)
        if (!outcome.ok) return outcome
        revisionRef.current = outcome.revision
        return { ok: true, evaluation: outcome.evaluation }
      } catch (error) {
        if (error instanceof MutationBlockedError) return { ok: false, failure: { kind: 'other', status: 0, code: null, message: error.message || null } }
        return { ok: false, failure: { kind: 'transient' } }
      } finally {
        release()
      }
    },
    [session.id],
  )

  const state = useConfiguratorEvaluation(evaluate, session.selections, session.evaluation)
  const [finalising, setFinalising] = React.useState(false)
  const [outcome, setOutcome] = React.useState<PanelOutcome | null>(null)
  const [added, setAdded] = React.useState(false)
  const [priceChange, setPriceChange] = React.useState<PriceChange | null>(null)
  const [finaliseConflict, setFinaliseConflict] = React.useState<SessionConflict | null>(null)

  const { failure, evaluation: shownEvaluation } = state
  const conflict = React.useMemo<SessionConflict | null>(
    () =>
      failure?.kind === 'session_changed'
        ? { session: failure.session, rejected: failure.rejected, shown: shownEvaluation?.selections ?? {} }
        : finaliseConflict,
    [failure, finaliseConflict, shownEvaluation],
  )

  const money = React.useCallback(
    (evaluation: WorkspaceEvaluation) => formatCurrency(evaluation.netPrice, evaluation.currencyCode, locale) ?? evaluation.netPrice,
    [locale],
  )

  const finalise = React.useCallback(
    async (expectedHash: string) => {
      const shown = state.evaluation
      setFinalising(true)
      setOutcome(null)
      try {
        const response = await post(FINALISE_API, { id: session.id, expectedHash, revision: revisionRef.current })
        const next = finaliseOutcomeFromResponse(response.status, response.result)
        if (next.kind === 'added') {
          const title = session.modelVersion.modelTitle ?? ''
          flash(
            next.replay
              ? t('product_configurator.configurator.finalise.replay', 'This configuration was already added to the quote in another window. The line is on the quote.')
              : t('product_configurator.configurator.finalise.added', '{title} added to the quote ({price} net).', {
                  title,
                  price: shown ? money(shown) : '',
                }),
            next.replay ? 'info' : 'success',
          )
          setAdded(true)
          router.push(quoteHref(session.quoteId, next.snapshotId))
          return
        }
        if (next.kind === 'result_changed') {
          setPriceChange(shown ? { from: money(shown), to: money(next.result) } : null)
          state.reset({ selections: state.selections, evaluation: next.result })
        }
        if (next.kind === 'not_finalisable' && next.result) state.reset({ selections: state.selections, evaluation: next.result })
        if (next.kind === 'session_changed') {
          setFinaliseConflict({ session: next.session, rejected: state.selections, shown: shown?.selections ?? {} })
          return
        }
        if (next.kind === 'write_failed' && !(await sessionStillOpen(session.id, next.status))) {
          onSessionMoved()
          return
        }
        setOutcome(next)
      } catch (error) {
        setOutcome(error instanceof MutationBlockedError ? { kind: 'other', message: error.message || null } : { kind: 'transient' })
      } finally {
        setFinalising(false)
      }
    },
    [money, onSessionMoved, post, router, session.id, session.modelVersion.modelTitle, session.quoteId, state, t],
  )

  const resolveConflict = React.useCallback(
    (choice: 'keep' | 'apply') => {
      if (!conflict) return
      revisionRef.current = conflict.session.revision
      setFinaliseConflict(null)
      setOutcome(null)
      if (choice === 'keep') {
        state.reset({ selections: conflict.session.selections, evaluation: conflict.session.evaluation })
        if (!conflict.session.evaluation) state.retry()
        return
      }
      state.reset({ selections: conflict.rejected, evaluation: conflict.session.evaluation })
      state.retry()
    },
    [conflict, state],
  )

  const dismissOutcome = React.useCallback(() => {
    setOutcome(null)
    setPriceChange(null)
  }, [])

  const discard = React.useCallback(async () => {
    const confirmed = await confirm({
      title: t('product_configurator.configurator.discard.title', 'Discard this configuration?'),
      text: t('product_configurator.configurator.discard.text', 'The choices are deleted and nothing is added to the quote.'),
      confirmText: t('product_configurator.configurator.discard.confirm', 'Discard configuration'),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      const response = await post(CANCEL_API, { id: session.id })
      if (response.ok) {
        flash(t('product_configurator.configurator.discard.done', 'Configuration discarded. Nothing was added to the quote.'), 'success')
        router.push(quoteHref(session.quoteId))
        return
      }
      const body = sessionStateSchema.pick({ status: true }).safeParse(response.result)
      if (response.status === 409) {
        setOutcome({ kind: 'session_not_open', status: body.success ? body.data.status : null })
        return
      }
      flash(t('product_configurator.configurator.discard.failed', 'Could not discard the configuration. Try again.'), 'error')
    } catch (error) {
      flash(
        error instanceof MutationBlockedError && error.message
          ? error.message
          : t('product_configurator.configurator.discard.failed', 'Could not discard the configuration. Try again.'),
        'error',
      )
    }
  }, [confirm, post, router, session.id, session.quoteId, t])

  return {
    state,
    finalising,
    added,
    outcome,
    priceChange,
    conflict,
    finalise,
    resolveConflict,
    dismissOutcome,
    discard,
    ConfirmDialogElement,
  }
}

async function sessionStillOpen(sessionId: string, reported: SessionStatus | null): Promise<boolean> {
  if (reported) return reported === 'open'
  try {
    const call = await apiCall<unknown>(`${SESSIONS_API}?id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
    const load = sessionLoadFromResponse(call.status, call.result)
    return load.status === 'ready' && load.session.status === 'open'
  } catch {
    return false
  }
}
