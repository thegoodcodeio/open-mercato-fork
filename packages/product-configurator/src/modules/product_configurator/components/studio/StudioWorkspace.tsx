"use client"

import * as React from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Tabs, TabsList, TabsTrigger, useTabsContext } from '@open-mercato/ui/primitives/tabs'
import { ConflictRefreshDialog } from './ConflictRefreshDialog'
import { DefinitionJsonEditor } from './DefinitionJsonEditor'
import { StudioHeader } from './StudioHeader'
import { MODELS_LIST_HREF } from './studioApi'
import { createStudioState, isDraftDirty, studioReducer, type StudioModelDetail, type StudioReloadResult } from './studioState'
import { groupIssuesByTab } from './studioRefs'
import { STUDIO_TABS, STUDIO_TAB_IDS, isStudioTabId } from './tabs/registry'
import type { StudioTabId, StudioTabProps } from './tabs/types'
import { useStudioActions } from './useStudioActions'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'
import { ValidationReportPanel } from './ValidationReportPanel'

type StudioWorkspaceProps = {
  initialDetail: StudioModelDetail
  reload: () => Promise<StudioReloadResult>
}

/** Mirrors the panel id `TabsTrigger` points `aria-controls` at. */
function StudioTabPanel({ value, hidden, children }: { value: StudioTabId; hidden: boolean; children: React.ReactNode }) {
  const { baseId } = useTabsContext()
  return (
    <div
      role="tabpanel"
      id={baseId ? `${baseId}-panel-${encodeURIComponent(value)}` : undefined}
      aria-labelledby={baseId ? `${baseId}-tab-${encodeURIComponent(value)}` : undefined}
      hidden={hidden}
      data-testid={`studio-tab-panel-${value}`}
    >
      {children}
    </div>
  )
}

export function StudioWorkspace({ initialDetail, reload }: StudioWorkspaceProps) {
  const t = useT()
  const [state, dispatch] = React.useReducer(studioReducer, initialDetail, createStudioState)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [dirtyTabs, setDirtyTabs] = React.useState<ReadonlySet<StudioTabId>>(() => new Set())
  const [jsonPending, setJsonPending] = React.useState(false)
  const pendingJsonRef = React.useRef<string | null>(null)
  const localDirty = dirtyTabs.size > 0 || jsonPending
  const actions = useStudioActions({ state, dispatch, reload, confirm, t, pendingJsonRef, localDirty })
  const dirty = isDraftDirty(state)
  const readOnly = actions.modelMissing || actions.busy === 'save' || actions.busy === 'publish' || actions.busy === 'refresh'
  const [visited, setVisited] = React.useState<ReadonlySet<StudioTabId>>(() => new Set([state.activeTab]))

  const confirmLeave = React.useCallback(
    () => confirm({ title: t('ui.forms.confirmUnsavedChanges', 'You have unsaved changes. Are you sure you want to leave?') }),
    [confirm, t],
  )
  useUnsavedChangesGuard(dirty || localDirty, confirmLeave)

  const onPendingJsonChange = React.useCallback((text: string | null) => {
    pendingJsonRef.current = text
    setJsonPending(text !== null)
  }, [])
  const dirtyChangeHandlers = React.useMemo(
    () =>
      new Map(
        STUDIO_TAB_IDS.map((id) => [
          id,
          (tabDirty: boolean) =>
            setDirtyTabs((current) => {
              if (current.has(id) === tabDirty) return current
              const next = new Set(current)
              if (tabDirty) next.add(id)
              else next.delete(id)
              return next
            }),
        ]),
      ),
    [],
  )

  React.useEffect(() => {
    setVisited((current) => (current.has(state.activeTab) ? current : new Set([...current, state.activeTab])))
  }, [state.activeTab])

  const issuesByTab = React.useMemo(
    () => (state.report ? groupIssuesByTab(state.report.report.issues, state.savedDefinition) : {}),
    [state.report, state.savedDefinition],
  )
  const navigate = React.useCallback((tab: StudioTabId, key?: string | null) => dispatch({ type: 'navigate', tab, key: key ?? null }), [])
  const onChange = React.useCallback<StudioTabProps['onChange']>(
    (update, referenceChange) => dispatch({ type: 'edit', update, referenceChange }),
    [],
  )
  const onModelSaved = React.useCallback<StudioTabProps['onModelSaved']>(
    (patch) => dispatch({ type: 'titleSaved', title: patch.title, updatedAt: patch.updatedAt }),
    [],
  )
  const onConflict = React.useCallback((error: unknown) => void actions.handleConflict(error), [actions])
  const draft = state.draft
  const priceKindId = state.savedDefinition?.commercial.priceKindId ?? state.draft?.commercial.priceKindId ?? null

  return (
    <div className="space-y-4" data-testid="model-studio">
      <StudioHeader
        model={state.model}
        priceKindId={priceKindId}
        dirty={dirty}
        localDirty={localDirty}
        canSave={state.draft !== null && !actions.modelMissing}
        modelMissing={actions.modelMissing}
        busy={actions.busy}
        onDiscard={() => void actions.discard()}
        onSave={() => void actions.save()}
        onValidate={() => void actions.validate()}
        onPublish={() => void actions.publish()}
      />
      {actions.modelMissing ? (
        <Alert
          status="error"
          action={
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void actions.copyDraft()}>
                {t('product_configurator.studio.conflict.copyDraft', 'Copy my draft (JSON)')}
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={MODELS_LIST_HREF}>{t('product_configurator.studio.backToModels', 'Back to models')}</Link>
              </Button>
            </div>
          }
          data-testid="studio-missing-alert"
        >
          <AlertTitle>{t('product_configurator.studio.notFound', 'Configuration model not found')}</AlertTitle>
          <AlertDescription>
            {t(
              'product_configurator.studio.missing.text',
              'Someone deleted this model after you opened it, so the draft cannot be saved. Copy your draft to keep your work.',
            )}
          </AlertDescription>
        </Alert>
      ) : state.conflict ? (
        <Alert
          status="error"
          action={
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void actions.copyDraft()}>
                {t('product_configurator.studio.conflict.copyDraft', 'Copy my draft (JSON)')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={actions.requestRefresh} disabled={actions.busy !== null}>
                {t('product_configurator.studio.conflict.refreshEllipsis', 'Refresh…')}
              </Button>
            </div>
          }
          data-testid="studio-conflict-alert"
        >
          <AlertTitle>{t('product_configurator.studio.conflict.title', 'Record changed')}</AlertTitle>
          <AlertDescription>
            {t('product_configurator.studio.conflict.text', 'Someone else saved this model after you opened it, so your save was refused.')}
          </AlertDescription>
        </Alert>
      ) : null}
      {state.published ? (
        <Alert status="success" data-testid="studio-published-alert">
          <AlertDescription>
            {t(
              'product_configurator.studio.published',
              'Published version {version}. New configurations use v{version}; configurations already in progress and existing quotes keep their version.',
              { version: state.published.version },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {state.report ? (
        <ValidationReportPanel
          report={state.report}
          definition={state.savedDefinition}
          dirty={dirty}
          onNavigate={navigate}
          onDismiss={() => dispatch({ type: 'report', report: null })}
        />
      ) : null}
      {state.draft === null ? (
        <Alert status="warning">
          <AlertTitle>{t('product_configurator.studio.repair.title', 'The saved draft needs a fix')}</AlertTitle>
          <AlertDescription>
            {t('product_configurator.studio.repair.text', 'The saved draft does not match the definition format. Fix it in Advanced (JSON) to use the other tabs.')}
          </AlertDescription>
        </Alert>
      ) : null}
      <Tabs
        variant="underline"
        value={state.activeTab}
        onValueChange={(value) => (isStudioTabId(value) ? dispatch({ type: 'selectTab', tab: value }) : undefined)}
      >
        <TabsList className="w-full overflow-x-auto overflow-y-hidden" aria-label={t('product_configurator.studio.tabs.label', 'Model sections')}>
          {STUDIO_TABS.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              className="shrink-0"
              disabled={state.draft === null && tab.id !== 'advanced'}
              count={issuesByTab[tab.id]?.length || undefined}
            >
              {t(tab.labelKey, tab.fallbackLabel)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="pt-4">
          {draft === null ? (
            <StudioTabPanel value="advanced" hidden={false}>
              <DefinitionJsonEditor
                key={state.epoch}
                source={state.savedRaw}
                currencyCode={state.model.currencyCode}
                readOnly={readOnly}
                onApply={(definition) => dispatch({ type: 'replace', definition })}
                onPendingChange={onPendingJsonChange}
              />
            </StudioTabPanel>
          ) : (
            STUDIO_TABS.filter((tab) => visited.has(tab.id) || tab.id === state.activeTab).map(({ id, component: TabComponent }) => (
              <StudioTabPanel key={`${id}-${state.epoch}`} value={id} hidden={id !== state.activeTab}>
                <TabComponent
                  model={state.model}
                  definition={draft}
                  savedDefinition={state.savedDefinition}
                  onChange={onChange}
                  referenceChanges={state.referenceChanges}
                  readOnly={readOnly}
                  unsavedChanges={dirty || localDirty}
                  issues={issuesByTab[id] ?? []}
                  selectedKey={state.selectedKeys[id] ?? null}
                  onSelectKey={(key) => dispatch({ type: 'selectKey', tab: id, key })}
                  onNavigate={navigate}
                  lockToken={state.lockToken}
                  onModelSaved={onModelSaved}
                  onConflict={onConflict}
                  onDirtyChange={dirtyChangeHandlers.get(id)}
                  onPendingJsonChange={onPendingJsonChange}
                />
              </StudioTabPanel>
            ))
          )}
        </div>
      </Tabs>
      <ConflictRefreshDialog
        open={actions.refreshConfirmOpen}
        busy={actions.busy !== null}
        onCopyDraft={() => void actions.copyDraft()}
        onCancel={actions.cancelRefresh}
        onRefresh={() => void actions.refresh()}
      />
      {ConfirmDialogElement}
    </div>
  )
}
