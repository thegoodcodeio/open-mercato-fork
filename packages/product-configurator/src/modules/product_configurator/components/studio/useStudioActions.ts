"use client"

import * as React from 'react'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { dismissRecordConflict } from '@open-mercato/ui/backend/conflicts'
import type { ConfirmDialogOptions } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import {
  buildOptimisticLockHeader,
  extractOptimisticLockConflict,
  extractRecordLockConflict,
} from '@open-mercato/ui/backend/utils/optimisticLock'
import {
  MODEL_RESOURCE_KIND,
  MODELS_API,
  PUBLISH_API,
  VALIDATE_API,
  parsePublishResponse,
  parseSaveResponse,
  parseValidationReport,
  readErrorBody,
} from './studioApi'
import { isDraftDirty, type StudioAction, type StudioReloadResult, type StudioState } from './studioState'
import type { StudioDefinition } from './tabs/types'

export type StudioBusy = 'save' | 'validate' | 'publish' | 'refresh' | null

type StudioMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

type UseStudioActionsInput = {
  state: StudioState
  dispatch: React.Dispatch<StudioAction>
  reload: () => Promise<StudioReloadResult>
  confirm: (options?: ConfirmDialogOptions) => Promise<boolean>
  t: TranslateFn
  /** Advanced JSON text typed but not applied: copied instead of the draft, and Save asks before leaving it out. */
  pendingJsonRef: React.RefObject<string | null>
  /** Unsaved edits outside the draft (pending JSON text, the Overview title form, an open row editor) that a refresh would drop. */
  localDirty: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function useStudioActions({ state, dispatch, reload, confirm, t, pendingJsonRef, localDirty }: UseStudioActionsInput) {
  const modelId = state.model.id
  const contextId = `product_configurator.studio:${modelId}`
  const { runMutation } = useGuardedMutation<StudioMutationContext>({
    contextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })
  const [busy, setBusy] = React.useState<StudioBusy>(null)
  const [refreshConfirmOpen, setRefreshConfirmOpen] = React.useState(false)
  const [modelMissing, setModelMissing] = React.useState(false)
  const stateRef = React.useRef(state)
  stateRef.current = state
  const localDirtyRef = React.useRef(localDirty)
  localDirtyRef.current = localDirty
  const lastRunRef = React.useRef<(() => Promise<boolean>) | null>(null)

  /** Injected widgets (e.g. record locks) retry through the context; rerun the whole action so its result updates the studio too. */
  const retryLastMutation = React.useCallback(async () => (lastRunRef.current ? lastRunRef.current() : false), [])

  const mutationContext = React.useMemo<StudioMutationContext>(
    () => ({ formId: contextId, resourceKind: MODEL_RESOURCE_KIND, resourceId: modelId, retryLastMutation }),
    [contextId, modelId, retryLastMutation],
  )

  const refresh = React.useCallback(async () => {
    setRefreshConfirmOpen(false)
    setBusy('refresh')
    try {
      const result = await reload()
      if (result.status === 'error') throw new Error(t('product_configurator.studio.flash.refreshFailed', 'Could not load the saved model. Try again.'))
      dismissRecordConflict()
      if (result.status === 'notFound') {
        setModelMissing(true)
        return
      }
      dispatch({ type: 'loaded', detail: result.detail })
    } catch (error) {
      flash(errorText(error, t('product_configurator.studio.flash.refreshFailed', 'Could not load the saved model. Try again.')), 'error')
    } finally {
      setBusy(null)
    }
  }, [dispatch, reload, t])

  const requestRefresh = React.useCallback(() => {
    if (isDraftDirty(stateRef.current) || localDirtyRef.current) {
      setRefreshConfirmOpen(true)
      return
    }
    void refresh()
  }, [refresh])

  /**
   * The studio bar (with "Copy my draft") is the only conflict surface, so the platform bar `useGuardedMutation`
   * shows is dismissed. A save on a deleted model also answers 409, so the model is looked up before blaming another save.
   */
  const handleConflict = React.useCallback(
    (error: unknown): boolean => {
      if (!extractOptimisticLockConflict(error) && !extractRecordLockConflict(error)) return false
      dismissRecordConflict()
      dispatch({ type: 'conflict' })
      void reload().then((result) => {
        if (result.status === 'notFound') setModelMissing(true)
      })
      return true
    },
    [dispatch, reload],
  )

  const runSave = React.useCallback(
    async (definition: StudioDefinition, lockToken: string | null): Promise<boolean> => {
      setBusy('save')
      try {
        const call = await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(lockToken), () =>
              apiCallOrThrow(MODELS_API, {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ id: modelId, draftDefinition: definition }),
              }),
            ),
          context: mutationContext,
          mutationPayload: { id: modelId, draftDefinition: definition },
        })
        const saved = parseSaveResponse(call.result)
        if (!saved) throw new Error(t('product_configurator.studio.flash.saveFailed', 'Could not save the draft.'))
        dispatch({ type: 'saved', definition, updatedAt: saved.updatedAt, draftHash: saved.draftHash })
        flash(t('product_configurator.studio.flash.saved', 'Draft saved.'), 'success')
        return true
      } catch (error) {
        if (!handleConflict(error)) flash(errorText(error, t('product_configurator.studio.flash.saveFailed', 'Could not save the draft.')), 'error')
        return false
      } finally {
        setBusy(null)
      }
    },
    [dispatch, handleConflict, modelId, mutationContext, runMutation, t],
  )

  const save = React.useCallback(async () => {
    if (!stateRef.current.draft || !isDraftDirty(stateRef.current)) return
    if (pendingJsonRef.current !== null) {
      const confirmed = await confirm({
        title: t('product_configurator.studio.json.pendingSave.title', 'Save without the text in Advanced (JSON)?'),
        text: t(
          'product_configurator.studio.json.pendingSave.text',
          'Advanced (JSON) has text that is not applied to the draft. Save draft stores the draft without it.',
        ),
        confirmText: t('product_configurator.studio.json.pendingSave.confirm', 'Save without it'),
      })
      if (!confirmed) return
    }
    const current = stateRef.current
    const definition = current.draft
    if (!definition || !isDraftDirty(current)) return
    const lockToken = current.lockToken
    lastRunRef.current = () => runSave(definition, lockToken)
    await runSave(definition, lockToken)
  }, [confirm, pendingJsonRef, runSave, t])

  const validate = React.useCallback(async () => {
    if (isDraftDirty(stateRef.current)) return
    setBusy('validate')
    try {
      const call = await apiCallOrThrow(VALIDATE_API, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id: modelId }) })
      const report = parseValidationReport(call.result)
      if (!report) throw new Error(t('product_configurator.studio.flash.validateFailed', 'Could not validate the draft.'))
      dispatch({ type: 'report', report: { source: 'validate', checkedAt: new Date().toISOString(), report } })
    } catch (error) {
      flash(errorText(error, t('product_configurator.studio.flash.validateFailed', 'Could not validate the draft.')), 'error')
    } finally {
      setBusy(null)
    }
  }, [dispatch, modelId, t])

  const runPublish = React.useCallback(
    async (lockToken: string | null): Promise<boolean> => {
      setBusy('publish')
      try {
        const call = await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(lockToken), () =>
              apiCallOrThrow(PUBLISH_API, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id: modelId }) }),
            ),
          context: mutationContext,
          mutationPayload: { id: modelId },
        })
        const published = parsePublishResponse(call.result)
        if (!published) throw new Error(t('product_configurator.studio.flash.publishFailed', 'Could not publish the model.'))
        dispatch({
          type: 'published',
          published: { version: published.version, modelVersionId: published.modelVersionId, hash: published.hash },
          updatedAt: published.updatedAt,
          publishedAt: new Date().toISOString(),
        })
        return true
      } catch (error) {
        const body = readErrorBody(error)
        if (body.code === 'validation_failed' && body.report) {
          dispatch({ type: 'report', report: { source: 'publish', checkedAt: new Date().toISOString(), report: body.report } })
          return false
        }
        if (!handleConflict(error)) flash(errorText(error, t('product_configurator.studio.flash.publishFailed', 'Could not publish the model.')), 'error')
        return false
      } finally {
        setBusy(null)
      }
    },
    [dispatch, handleConflict, modelId, mutationContext, runMutation, t],
  )

  const publish = React.useCallback(async () => {
    const current = stateRef.current
    if (isDraftDirty(current)) return
    const lockToken = current.lockToken
    lastRunRef.current = () => runPublish(lockToken)
    await runPublish(lockToken)
  }, [runPublish])

  const discard = React.useCallback(async () => {
    if (!isDraftDirty(stateRef.current)) return
    const confirmed = await confirm({
      title: t('product_configurator.studio.discard.title', 'Discard unsaved changes?'),
      text: t('product_configurator.studio.discard.text', 'Your unsaved edits are replaced by the last saved draft.'),
      confirmText: t('product_configurator.studio.discard.confirm', 'Discard changes'),
      variant: 'destructive',
    })
    if (confirmed) dispatch({ type: 'discard' })
  }, [confirm, dispatch, t])

  const copyDraft = React.useCallback(async () => {
    const current = stateRef.current
    const text = pendingJsonRef.current ?? JSON.stringify(current.draft ?? current.savedRaw, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      flash(t('product_configurator.studio.flash.draftCopied', 'Your draft is copied to the clipboard as JSON.'), 'success')
    } catch {
      flash(t('product_configurator.studio.flash.copyFailed', 'Could not copy the draft. Open Advanced (JSON) and copy the text.'), 'error')
    }
  }, [pendingJsonRef, t])

  return {
    busy,
    save,
    validate,
    publish,
    discard,
    copyDraft,
    refresh,
    requestRefresh,
    handleConflict,
    refreshConfirmOpen,
    /** The model was deleted after the studio opened it: only copying the draft is left. */
    modelMissing,
    cancelRefresh: React.useCallback(() => setRefreshConfirmOpen(false), []),
  }
}
