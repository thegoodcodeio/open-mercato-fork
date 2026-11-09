"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { ConfiguratorWorkspace } from '../../configurator/ConfiguratorWorkspace'
import type { WorkspaceSelections } from '../../configurator/evaluationSchema'
import { pruneSelections } from '../../configurator/workspaceModel'
import { PreviewContextForm } from './test/PreviewContextForm'
import { REFERENCE_CONTEXT, isReferenceContext, requestPreview, type FiredRule, type PreviewContext } from './test/previewApi'
import type { StudioTabProps } from './types'

/** Runs the configurator workspace against the saved draft through `POST /models/preview`: no session, nothing stored. */
export function TestTab({ model, savedDefinition, unsavedChanges }: StudioTabProps) {
  const t = useT()
  const [context, setContext] = React.useState<PreviewContext>(REFERENCE_CONTEXT)
  const [firedRules, setFiredRules] = React.useState<FiredRule[] | null>(null)
  const requestRef = React.useRef(0)

  const evaluate = React.useCallback(
    async (selections: WorkspaceSelections) => {
      const request = ++requestRef.current
      const sent = savedDefinition ? pruneSelections(savedDefinition, selections) : selections
      const outcome = await requestPreview(model.id, sent, context)
      if (request === requestRef.current) setFiredRules(outcome.ok ? outcome.firedRules : null)
      return outcome
    },
    [context, model.id, savedDefinition],
  )

  if (!savedDefinition) {
    return (
      <Alert status="warning">
        <AlertDescription>
          {t('product_configurator.studio.test.needsValidDraft', 'The saved draft needs a fix in Advanced (JSON) before it can be tested.')}
        </AlertDescription>
      </Alert>
    )
  }

  const ruleName = (rule: FiredRule) => (rule.label ? `${rule.label} (${rule.ruleId})` : rule.ruleId)

  return (
    <div className="space-y-4" data-testid="studio-test-tab">
      <Alert status="information">
        <AlertDescription>
          {t(
            'product_configurator.studio.test.banner',
            'Testing the saved draft (not published). No configuration is saved and nothing is added to any quote.',
          )}
        </AlertDescription>
      </Alert>
      {unsavedChanges ? (
        <Alert status="warning" data-testid="studio-test-unsaved">
          <AlertDescription>
            {t('product_configurator.studio.test.unsaved', 'You have unsaved changes. This test uses the saved draft; save the draft to test them.')}
          </AlertDescription>
        </Alert>
      ) : null}
      <PreviewContextForm value={context} onChange={setContext} />
      <ConfiguratorWorkspace
        definition={savedDefinition}
        evaluate={evaluate}
        priceLabel={
          isReferenceContext(context)
            ? t('product_configurator.studio.test.priceLabelReference', 'Net price ({currency}), reference context', { currency: model.currencyCode })
            : t('product_configurator.studio.test.priceLabel', 'Net price ({currency})', { currency: model.currencyCode })
        }
        priceNote={t('product_configurator.studio.test.priceNote', 'Catalog prices for this context; saved draft definition.')}
        messagesFooter={
          firedRules ? (
            <p className="text-xs text-muted-foreground" data-testid="studio-test-trace">
              {firedRules.length
                ? t('product_configurator.studio.test.firedRules', 'Rules that fired: {rules}', { rules: firedRules.map(ruleName).join(', ') })
                : t('product_configurator.studio.test.noFiredRules', 'No rule fired for these choices.')}
            </p>
          ) : null
        }
      />
    </div>
  )
}
