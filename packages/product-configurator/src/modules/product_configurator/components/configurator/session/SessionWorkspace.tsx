"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { ConfiguratorWorkspaceView, type WorkspaceActionState } from '../ConfiguratorWorkspace'
import { CopyReviewDialog } from './CopyReviewDialog'
import { FinaliseOutcomePanel, type OutcomeAction } from './FinaliseOutcomePanel'
import { migrationReasonText, resetFieldNotes } from './migrationText'
import { SessionChangedPanel } from './SessionChangedPanel'
import { SessionHeader, sessionTitle } from './SessionHeader'
import { FINALISE_FEATURE, migrationChanges, type PanelOutcome, type SessionDetail } from './sessionApi'
import { useSessionWorkspace } from './useSessionWorkspace'

const TERMINAL_OUTCOMES: ReadonlyArray<PanelOutcome['kind']> = ['quote_converted', 'cannot_add', 'session_not_open', 'added_with_earlier_choices']

/** Terminal outcomes after which nothing is left to discard. */
const NOTHING_TO_DISCARD: ReadonlyArray<PanelOutcome['kind']> = ['quote_converted', 'added_with_earlier_choices']

/** The configurator on an open session: header, live workspace, "Add to quote" and its outcomes. */
export function SessionWorkspace({ session, onSessionMoved }: { session: SessionDetail; onSessionMoved: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { payload: chrome, isReady: chromeReady } = useBackendChrome()
  const workspace = useSessionWorkspace(session, onSessionMoved)
  const { state, outcome, conflict, finalising, added } = workspace
  const definition = session.modelVersion.definition
  const migration = session.migration
  const changedCount = migrationChanges(migration).length
  const fieldNotes = React.useMemo(
    () => resetFieldNotes(definition, migration, state.evaluation, locale, t),
    [definition, migration, state.evaluation, locale, t],
  )
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
      {migration && changedCount > 0 ? (
        <Alert status="warning" data-testid="configurator-migration-notice">
          <AlertDescription>
            <p>
              {t(
                'product_configurator.configurator.migration.notice',
                'Model v{version} changed {count} of the copied choices. They are marked below and listed again before the copy is added.',
                { version: migration.toVersion.version, count: changedCount },
              )}
            </p>
            {migration.dropped.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {migration.dropped.map((item) => (
                  <li key={item.featureKey}>{migrationReasonText(item, migration, locale, t)}</li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {conflict ? <SessionChangedPanel definition={definition} conflict={conflict} onResolve={workspace.resolveConflict} /> : null}
      <ConfiguratorWorkspaceView
        definition={definition}
        state={state}
        readOnly={readOnly}
        fieldNotes={fieldNotes}
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
      {workspace.review ? (
        <CopyReviewDialog
          definition={definition}
          migration={workspace.review}
          evaluation={state.evaluation}
          title={sessionTitle(session, t)}
          busy={finalising || state.pending}
          onEditChoices={workspace.closeReview}
          onConfirm={workspace.confirmReview}
        />
      ) : null}
      {workspace.ConfirmDialogElement}
    </div>
  )
}
