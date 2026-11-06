"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CrudForm, type CrudCustomFieldRenderProps, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { extractOptimisticLockConflict } from '@open-mercato/ui/backend/utils/optimisticLock'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { Input } from '@open-mercato/ui/primitives/input'
import { MODELS_API, parseSaveResponse } from '../studioApi'
import { useCatalogLabels } from '../useCatalogLabels'
import type { StudioTabProps } from './types'

type OverviewValues = {
  id: string
  title: string
  modelKey: string
  currencyCode: string
  product: string
  priceKind: string
}

type TitleInputProps = CrudCustomFieldRenderProps & {
  savedTitle: string
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * Reports its own dirtiness to the studio guard. CrudForm's `trackDirtyWhenEmbedded` would install a second
 * navigation guard next to the studio one, and both would answer browser Back.
 */
function TitleInput({ id, value, error, disabled, setValue, savedTitle, onDirtyChange }: TitleInputProps) {
  const text = typeof value === 'string' ? value : ''
  const dirty = text !== savedTitle
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  return (
    <Input
      id={id}
      value={text}
      maxLength={200}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      onChange={(event) => setValue(event.target.value)}
    />
  )
}

/** Only the title is editable; key, currency, product and price kind are fixed when the model is created. */
export function OverviewTab({ model, definition, readOnly, lockToken, onModelSaved, onConflict, onDirtyChange }: StudioTabProps) {
  const t = useT()
  const priceKindId = definition.commercial.priceKindId
  const labels = useCatalogLabels(model.productId, priceKindId)

  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const fields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'title',
        type: 'custom',
        label: t('product_configurator.studio.overview.title', 'Title'),
        required: true,
        component: (props) => <TitleInput {...props} savedTitle={model.title} onDirtyChange={onDirtyChange} />,
      },
      { id: 'modelKey', type: 'text', label: t('product_configurator.studio.overview.modelKey', 'Key'), disabled: true, layout: 'half' },
      { id: 'currencyCode', type: 'text', label: t('product_configurator.studio.overview.currency', 'Currency'), disabled: true, layout: 'half' },
      { id: 'product', type: 'text', label: t('product_configurator.studio.overview.product', 'Catalog product'), disabled: true, layout: 'half' },
      { id: 'priceKind', type: 'text', label: t('product_configurator.studio.overview.priceKind', 'Price kind'), disabled: true, layout: 'half' },
    ],
    [model.title, onDirtyChange, t],
  )

  const initialValues = React.useMemo<OverviewValues>(
    () => ({
      id: model.id,
      title: model.title,
      modelKey: model.modelKey,
      currencyCode: model.currencyCode,
      product: labels.product ?? model.productId,
      priceKind: labels.priceKind ?? priceKindId,
    }),
    [labels.priceKind, labels.product, model.currencyCode, model.id, model.modelKey, model.productId, model.title, priceKindId],
  )

  const handleSubmit = async (values: OverviewValues) => {
    const title = values.title.trim()
    if (!title) {
      const message = t('product_configurator.studio.overview.titleRequired', 'Enter a title.')
      throw createCrudFormError(message, { title: message })
    }
    try {
      const call = await apiCallOrThrow(MODELS_API, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: model.id, title }),
      })
      const saved = parseSaveResponse(call.result)
      if (!saved) throw createCrudFormError(t('product_configurator.studio.overview.saveFailed', 'Could not save the title.'))
      onModelSaved({ title, updatedAt: saved.updatedAt })
      flash(t('product_configurator.studio.overview.saved', 'Title saved.'), 'success')
    } catch (error) {
      if (!extractOptimisticLockConflict(error)) throw error
      // Rethrowing the 409 would let CrudForm replace the studio's conflict bar with one that reloads the page and drops the draft.
      onConflict(error)
      const message = t('product_configurator.studio.overview.conflict', 'Someone else saved this model. Refresh to load their version.')
      throw createCrudFormError(message, { title: message })
    }
  }

  return (
    <CrudForm<OverviewValues>
      embedded
      formId={`product_configurator-model-overview-${model.id}`}
      fields={fields}
      initialValues={initialValues}
      optimisticLockUpdatedAt={lockToken}
      readOnly={readOnly}
      submitLabel={t('product_configurator.studio.overview.submit', 'Save title')}
      onSubmit={handleSubmit}
    />
  )
}
