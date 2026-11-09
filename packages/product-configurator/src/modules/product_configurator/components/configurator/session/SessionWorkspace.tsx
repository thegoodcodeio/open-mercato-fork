"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { ConfiguratorWorkspaceView, type WorkspaceActionState } from '../ConfiguratorWorkspace'
import { FinaliseOutcomePanel, type OutcomeAction } from './FinaliseOutcomePanel'
import { SessionChangedPanel } from './SessionChangedPanel'
import { SessionHeader } from './SessionHeader'
import { FINALISE_FEATURE, type PanelOutcome, type SessionDetail } from './sessionApi'
import { useSessionWorkspace } from './useSessionWorkspace'

const TERMINAL_OUTCOMES: ReadonlyArray<PanelOutcome['kind']> = ['quote_converted', 'cannot_add', 'session_not_open', 'added_with_earlier_choices']

/** Terminal outcomes after which nothing is left to discard. */
const NOTHING_TO_DISCARD: ReadonlyArray<PanelOutcome['kind']> = ['quote_converted', 'added_with_earlier_choices']

/**
 * The configurator on an open session: header, live workspace, "Add to quote" and its outcomes. A session that
 * another window added or discarded leaves only the header and the explanation, like a reloaded closed session.
 */
export function SessionWorkspace({ session, onSessionMoved }: { session: SessionDetail; onSessionMoved: () => void }) {
  const t = useT()
  const { payload: chrome, isReady: chromeReady } = useBackendChrome()
  const workspace = useSessionWorkspace(session, onSessionMoved)
  const { state, outcome, conflict, finalising, added } = workspace
  const definition = session.modelVersion.definition
  const missingEditRights = chromeReady && !hasFeature(chrome?.grantedFeatures, FINALISE_FEATURE)
  const shownOutcome: PanelOutcome | null =
    outcome ?? (state.failure?.kind === 'session_not_open' ? { kind: 'session_not_open', status: state.failure.status } : null)
  const terminal = shownOutcome !== null && TERMINAL_OUTCOMES.includes(shownOutcome.kind)
  const readOnly = finalising || added || terminal
  const canAdd = (ready: boolean) => ready && !missingEditRights && conflict === null && !readOnly

  const addToQuote = (ready: boolean) => {
    if (canAdd(ready) && state.evaluation) void workspace.finalise(state.evaluation.hash)
  }

  const onOutcomeAction = (action: Exclude<OutcomeAction, 'open_quote' | 'quotes'>, ready: boolean) => {
    if (action === 'dismiss') return workspace.dismissOutcome()
    if (action === 'discard') return void workspace.discard()
    addToQuote(ready)
  }

  if (shownOutcome?.kind === 'session_not_open') {
    return (
      <div className="space-y-4" data-testid="configurator-session-closed">
        <SessionHeader session={session} />
        <FinaliseOutcomePanel outcome={shownOutcome} definition={definition} priceChange={null} quoteId={session.quoteId} addDisabled onAction={() => undefined} />
      </div>
    )
  }

  const renderAction = ({ ready, placement }: WorkspaceActionState) => (
    <Button
      type="button"
      disabled={!canAdd(ready)}
      onClick={() => addToQuote(ready)}
      data-testid={placement === 'bar' ? 'configurator-add-to-quote-bar' : 'configurator-add-to-quote'}
    >
      {finalising ? <Spinner size="sm" /> : null}
      {t('product_configurator.configurator.addToQuote', 'Add to quote')}
    </Button>
  )

  return (
    <div className="space-y-4" data-testid="configurator-session">
      <SessionHeader
        session={session}
        actions={
          shownOutcome && NOTHING_TO_DISCARD.includes(shownOutcome.kind) ? null : (
            <Button type="button" variant="destructive-outline" size="sm" disabled={finalising || added} onClick={() => void workspace.discard()}>
              {t('product_configurator.configurator.discard.confirm', 'Discard configuration')}
            </Button>
          )
        }
      />
      {conflict ? <SessionChangedPanel definition={definition} conflict={conflict} onResolve={workspace.resolveConflict} /> : null}
      <ConfiguratorWorkspaceView
        definition={definition}
        state={state}
        readOnly={readOnly}
        priceLabel={t('product_configurator.configurator.priceLabel', 'Net price ({currency})', { currency: definition.commercial.currencyCode })}
        priceNote={t('product_configurator.configurator.priceNote', 'Tax and discounts are added on the quote.')}
        renderAction={renderAction}
        renderSummaryNotice={({ ready }) => (
          <>
            {missingEditRights ? (
              <p className="text-sm text-muted-foreground" data-testid="configurator-no-edit-rights">
                {t(
                  'product_configurator.configurator.noEditRights',
                  'Your choices are saved. Someone who can edit this quote can finish it from the Configurations tab.',
                )}
              </p>
            ) : null}
            {shownOutcome ? (
              <FinaliseOutcomePanel
                outcome={shownOutcome}
                definition={definition}
                priceChange={workspace.priceChange}
                quoteId={session.quoteId}
                addDisabled={!canAdd(ready)}
                onAction={(action) => onOutcomeAction(action, ready)}
              />
            ) : null}
          </>
        )}
      />
      {workspace.ConfirmDialogElement}
    </div>
  )
}
