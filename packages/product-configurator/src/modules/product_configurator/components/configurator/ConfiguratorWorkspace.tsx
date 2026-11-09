"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import type { ConfigurationDefinition } from '../../data/validators'
import { pluralLabel } from '../studio/pluralLabel'
import { ConfigurationDetails } from './ConfigurationDetails'
import type { WorkspaceEvaluation, WorkspaceSelections } from './evaluationSchema'
import { FeatureField } from './FeatureField'
import { failureText, selectionIssueText } from './failureMessages'
import { useConfiguratorEvaluation, type ConfiguratorEvaluateFn, type ConfiguratorEvaluationState } from './useConfiguratorEvaluation'
import { featureFieldId, featureGroups, workspaceMessages } from './workspaceModel'

const HIGHLIGHT_MS = 2000

export type WorkspaceActionState = {
  /** False while evaluating, failed, blocked or with invalid field text. */
  ready: boolean
  evaluation: WorkspaceEvaluation | null
  /** Where the action renders: the summary, or the bottom bar shown instead of the sticky summary on a narrow screen. */
  placement: 'summary' | 'bar'
}

type WorkspaceLayoutProps = {
  definition: ConfigurationDefinition
  /** Caption above the net price, e.g. "Net price (EUR)". */
  priceLabel: string
  priceNote?: React.ReactNode
  /** Primary action of the summary. When set, a narrow screen also gets a bottom bar with the price and the action. */
  renderAction?: (state: WorkspaceActionState) => React.ReactNode
  messagesFooter?: React.ReactNode
  /** Shown in the summary under the status (for example the outcome of "Add to quote", whose actions need `ready` too). */
  renderSummaryNotice?: (state: Omit<WorkspaceActionState, 'placement'>) => React.ReactNode
  /** Locks every field, for example while the configuration is being added. */
  readOnly?: boolean
}

export type ConfiguratorWorkspaceProps = WorkspaceLayoutProps & {
  /** Evaluates the choices: a session evaluate, or the studio preview of the saved draft. Keep it stable; a new function re-evaluates. */
  evaluate: ConfiguratorEvaluateFn
  initialSelections?: WorkspaceSelections
}

/** Options grouped by `group` with a summary (net price, status, messages, BOM) next to them. */
export function ConfiguratorWorkspace({ evaluate, initialSelections, ...layout }: ConfiguratorWorkspaceProps) {
  const state = useConfiguratorEvaluation(evaluate, initialSelections)
  return <ConfiguratorWorkspaceView {...layout} state={state} />
}

/** The workspace for a caller that owns the evaluation state (a session, which also resets it after a conflict). */
export function ConfiguratorWorkspaceView({
  definition,
  state,
  priceLabel,
  priceNote,
  renderAction,
  messagesFooter,
  renderSummaryNotice,
  readOnly = false,
}: WorkspaceLayoutProps & { state: ConfiguratorEvaluationState }) {
  const t = useT()
  const locale = useLocale()
  const { evaluation, pending, failure } = state
  const [invalidFields, setInvalidFields] = React.useState<ReadonlySet<string>>(() => new Set())
  const [highlighted, setHighlighted] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const [focusRequest, setFocusRequest] = React.useState<{ featureKey: string } | null>(null)

  const groups = React.useMemo(() => featureGroups(definition, evaluation?.visibility ?? null), [definition, evaluation])
  const messages = React.useMemo(() => (evaluation ? workspaceMessages(definition, evaluation, locale, t) : []), [definition, evaluation, locale, t])
  const shown = failure && failure.kind !== 'transient' && failure.kind !== 'session_changed' ? null : evaluation
  const netPrice = shown ? (formatCurrency(shown.netPrice, shown.currencyCode, locale) ?? shown.netPrice) : null
  const fieldErrors = React.useMemo(() => {
    const errors = new Map<string, string>()
    if (failure?.kind === 'selection') for (const issue of failure.issues) errors.set(issue.featureKey, selectionIssueText(issue, t))
    return errors
  }, [failure, t])

  React.useEffect(() => {
    if (!evaluation || pending) return
    const blocking = evaluation.errors.length
    setAnnouncement(
      t('product_configurator.configurator.live', 'Net price {price}. {messages}, {blocking} blocking.', {
        price: formatCurrency(evaluation.netPrice, evaluation.currencyCode, locale) ?? evaluation.netPrice,
        messages: pluralLabel(t, locale, 'product_configurator.configurator.liveMessages', '{count} messages', messages.length),
        blocking,
      }),
    )
  }, [evaluation, pending, messages.length, locale, t])

  React.useEffect(() => {
    if (!highlighted) return
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlighted])

  const goToFeature = React.useCallback(
    (featureKey: string) => {
      const groupKey = definition.features.find((feature) => feature.key === featureKey)?.group ?? ''
      setCollapsed((current) => {
        if (!current.has(groupKey)) return current
        const next = new Set(current)
        next.delete(groupKey)
        return next
      })
      setFocusRequest({ featureKey })
    },
    [definition],
  )

  React.useEffect(() => {
    if (!focusRequest) return
    const field = document.getElementById(`${featureFieldId(focusRequest.featureKey)}-field`)
    if (!field) return
    field.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const target = field.querySelector<HTMLElement>('[tabindex="0"], input, button[role="switch"], button[role="combobox"]')
    target?.focus()
    setHighlighted(focusRequest.featureKey)
  }, [focusRequest])

  const setInvalid = React.useCallback((featureKey: string, invalid: boolean) => {
    setInvalidFields((current) => {
      if (current.has(featureKey) === invalid) return current
      const next = new Set(current)
      if (invalid) next.add(featureKey)
      else next.delete(featureKey)
      return next
    })
  }, [])

  const forcedRuleLabel = (featureKey: string) => {
    const change = evaluation?.forced.find((entry) => entry.featureKey === featureKey)
    if (!change) return null
    return definition.rules.find((rule) => rule.id === change.ruleId)?.label ?? t('product_configurator.configurator.forced.byRule', 'a rule of this model')
  }
  const displayValue = (featureKey: string) => {
    const intent = state.selections[featureKey]
    if ((pending || failure) && intent !== undefined) return intent
    return evaluation?.selections[featureKey] ?? intent ?? definition.features.find((feature) => feature.key === featureKey)?.default ?? null
  }
  const ready = Boolean(evaluation?.finalisable) && !pending && !failure && invalidFields.size === 0 && !readOnly
  const failureMessage = failure ? failureText(definition, failure, t) : null
  const firstInvalid = readOnly ? null : (definition.features.find((feature) => invalidFields.has(feature.key)) ?? null)

  return (
    <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]', renderAction && 'pb-24 lg:pb-0')} data-testid="configurator-workspace">
      <fieldset disabled={readOnly} className="min-w-0 space-y-4">
        {groups.map((group) => {
          const groupKey = group.name ?? ''
          const open = !collapsed.has(groupKey)
          const panelId = `configurator-group-${encodeURIComponent(groupKey || 'default')}`
          return (
            <section key={groupKey} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (open) next.add(groupKey)
                      else next.delete(groupKey)
                      return next
                    })
                  }
                >
                  {group.name ?? t('product_configurator.configurator.groups.default', 'Choices')}
                </button>
              </h3>
              <div id={panelId} hidden={!open} className="space-y-3">
                {group.features.map((feature) => (
                  <FeatureField
                    key={feature.key}
                    definition={definition}
                    feature={feature}
                    value={displayValue(feature.key)}
                    allowedValues={evaluation?.availability[feature.key]?.allowedValues ?? null}
                    forcedBy={forcedRuleLabel(feature.key)}
                    serverError={fieldErrors.get(feature.key) ?? null}
                    highlighted={highlighted === feature.key}
                    resetGeneration={state.resetGeneration}
                    onChange={(value) => state.setSelection(feature.key, value)}
                    onInvalidChange={(invalid) => setInvalid(feature.key, invalid)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </fieldset>
      <div className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
        <section className="space-y-2 rounded-lg border border-border bg-card p-4" aria-busy={pending} data-testid="configurator-summary">
          <div className="flex items-start justify-between gap-3">
            <div className={cn(pending && 'opacity-60')}>
              <p className="text-xs uppercase text-muted-foreground">{priceLabel}</p>
              <p className="text-2xl font-semibold tabular-nums" data-testid="configurator-net-price">
                {netPrice ?? '-'}
              </p>
            </div>
            {renderAction ? <div className="hidden lg:block">{renderAction({ ready, evaluation: shown, placement: 'summary' })}</div> : null}
          </div>
          {pending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t('product_configurator.configurator.updating', 'Updating configuration…')}
            </p>
          ) : shown && !shown.finalisable ? (
            <p className="text-sm text-muted-foreground">
              {t('product_configurator.configurator.notFinal', 'Not final while a blocking message is shown.')}
            </p>
          ) : null}
          {priceNote ? <div className="text-xs text-muted-foreground">{priceNote}</div> : null}
          {failureMessage && !pending ? (
            <Alert
              status={failure?.kind === 'selection' ? 'warning' : 'error'}
              action={
                failure?.kind === 'transient' ? (
                  <Button type="button" variant="outline" size="sm" onClick={state.retry}>
                    {t('product_configurator.configurator.retry', 'Retry')}
                  </Button>
                ) : undefined
              }
              data-testid="configurator-failure"
            >
              <AlertDescription>{failureMessage}</AlertDescription>
            </Alert>
          ) : null}
          {firstInvalid ? (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-status-error-text" data-testid="configurator-invalid-field">
              {t('product_configurator.configurator.invalidField', 'Fix the value of {label} to continue.', { label: firstInvalid.label })}
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => goToFeature(firstInvalid.key)}>
                {t('product_configurator.configurator.showField', 'Show the field')}
              </Button>
            </p>
          ) : null}
          {renderSummaryNotice ? renderSummaryNotice({ ready, evaluation: shown }) : null}
        </section>
        {shown ? (
          <div className={cn('space-y-4', pending && 'opacity-60')}>
            <ConfigurationDetails
              definition={definition}
              evaluation={shown}
              messages={messages}
              onGoToFeature={goToFeature}
              messagesFooter={messagesFooter}
            />
          </div>
        ) : null}
      </div>
      {renderAction ? (
        <div
          className="fixed inset-x-0 bottom-0 z-sticky flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 lg:hidden"
          data-testid="configurator-bottom-bar"
        >
          <div className={cn('min-w-0', pending && 'opacity-60')}>
            <p className="truncate text-xs text-muted-foreground">{priceLabel}</p>
            <p className="text-lg font-semibold tabular-nums">{netPrice ?? '-'}</p>
          </div>
          {renderAction({ ready, evaluation: shown, placement: 'bar' })}
        </div>
      ) : null}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
