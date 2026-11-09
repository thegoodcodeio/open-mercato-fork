"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { MODELS_LIST_HREF, modelDetailUrl, parseModelDetail } from './studioApi'
import type { StudioModelDetail, StudioReloadResult } from './studioState'
import { StudioWorkspace } from './StudioWorkspace'

type LoadState = { status: 'loading' } | StudioReloadResult

class ModelNotFoundError extends Error {}

/** Client island of the studio page: loads the model, then hands it to the workspace that owns the draft. */
export function ModelStudio({ modelId }: { modelId: string }) {
  const t = useT()
  const [loadState, setLoadState] = React.useState<LoadState>({ status: 'loading' })

  const fetchDetail = React.useCallback(async (): Promise<StudioModelDetail> => {
    const call = await apiCall(modelDetailUrl(modelId))
    if (call.status === 404) throw new ModelNotFoundError('[internal] model not found')
    const detail = call.ok ? parseModelDetail(call.result) : null
    if (!detail) throw new Error('[internal] model detail unavailable')
    return detail
  }, [modelId])

  const reload = React.useCallback(async (): Promise<StudioReloadResult> => {
    try {
      return { status: 'ready', detail: await fetchDetail() }
    } catch (error) {
      return { status: error instanceof ModelNotFoundError ? 'notFound' : 'error' }
    }
  }, [fetchDetail])

  const load = React.useCallback(async () => {
    setLoadState({ status: 'loading' })
    setLoadState(await reload())
  }, [reload])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loadState.status === 'loading') {
    return <LoadingMessage label={t('product_configurator.studio.loading', 'Loading the model…')} />
  }
  if (loadState.status === 'notFound') {
    return (
      <RecordNotFoundState
        label={t('product_configurator.studio.notFound', 'Configuration model not found')}
        backHref={MODELS_LIST_HREF}
        backLabel={t('product_configurator.studio.backToModels', 'Back to models')}
      />
    )
  }
  if (loadState.status === 'error') {
    return (
      <ErrorMessage
        label={t('product_configurator.studio.loadFailed', 'Could not load the model.')}
        action={
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('product_configurator.studio.retry', 'Try again')}
          </Button>
        }
      />
    )
  }
  return <StudioWorkspace key={loadState.detail.id} initialDetail={loadState.detail} reload={reload} />
}
