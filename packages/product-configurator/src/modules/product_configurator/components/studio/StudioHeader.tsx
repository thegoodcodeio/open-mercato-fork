"use client"

import * as React from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { LinkButton } from '@open-mercato/ui/primitives/link-button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { buildModelVersionHref } from '../models/modelsApi'
import type { StudioBusy } from './useStudioActions'
import { useCatalogLabels } from './useCatalogLabels'
import type { StudioModelInfo } from './tabs/types'

type StudioHeaderProps = {
  model: StudioModelInfo
  priceKindId: string | null
  dirty: boolean
  /** Unsaved edits outside the draft (an open row editor, the title form, unapplied JSON): only the hint shows them. */
  localDirty?: boolean
  canSave: boolean
  /** The model was deleted after the studio opened: nothing can be validated or published. */
  modelMissing?: boolean
  busy: StudioBusy
  onDiscard: () => void
  onSave: () => void
  onValidate: () => void
  onPublish: () => void
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-sm text-muted-foreground">
      {label} <span className="text-foreground">{value}</span>
    </span>
  )
}

export function StudioHeader({
  model,
  priceKindId,
  dirty,
  localDirty = false,
  canSave,
  modelMissing = false,
  busy,
  onDiscard,
  onSave,
  onValidate,
  onPublish,
}: StudioHeaderProps) {
  const t = useT()
  const labels = useCatalogLabels(model.productId, priceKindId)
  const working = busy !== null
  const nothingToPublish = model.latestVersion !== null && !model.hasUnpublishedChanges
  const busyIcon = (action: StudioBusy) => (busy === action ? <Spinner className="mr-2 size-4" /> : null)

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between" data-testid="studio-header">
      <div className="min-w-0 space-y-2">
        <h1 className="truncate text-2xl font-semibold text-foreground">{model.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {model.latestVersion ? (
            <StatusBadge variant="success" dot>
              {t('product_configurator.studio.header.published', 'Published v{version}', { version: model.latestVersion.version })}
            </StatusBadge>
          ) : (
            <StatusBadge variant="neutral" dot>
              {t('product_configurator.studio.header.notPublished', 'Not published')}
            </StatusBadge>
          )}
          {model.hasUnpublishedChanges ? (
            <StatusBadge variant="warning" dot>
              {t('product_configurator.studio.header.unpublishedChanges', 'Unpublished changes')}
            </StatusBadge>
          ) : null}
          {model.latestVersion ? (
            <LinkButton asChild size="sm">
              <Link href={buildModelVersionHref(model.id, model.latestVersion.id)}>
                {t('product_configurator.models.list.actions.viewPublished', 'View published v{version}', {
                  version: model.latestVersion.version,
                })}
              </Link>
            </LinkButton>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <MetaItem label={t('product_configurator.studio.header.key', 'Key')} value={model.modelKey} />
          <MetaItem label={t('product_configurator.studio.header.currency', 'Currency')} value={model.currencyCode} />
          <MetaItem
            label={t('product_configurator.studio.header.priceKind', 'Price kind')}
            value={labels.priceKind ?? priceKindId ?? t('product_configurator.studio.header.unknown', 'Unknown')}
          />
          <MetaItem label={t('product_configurator.studio.header.product', 'Product')} value={labels.product ?? model.productId} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? (
            <Button type="button" variant="destructive-ghost" onClick={onDiscard} disabled={working}>
              {t('product_configurator.studio.actions.discard', 'Discard unsaved changes')}
            </Button>
          ) : null}
          <Button type="button" onClick={onSave} disabled={!dirty || !canSave || working}>
            {busyIcon('save')}
            {t('product_configurator.studio.actions.save', 'Save draft')}
          </Button>
          <Button type="button" variant="outline" onClick={onValidate} disabled={dirty || working || modelMissing}>
            {busyIcon('validate')}
            {t('product_configurator.studio.actions.validate', 'Validate')}
          </Button>
          <Button type="button" variant="outline" onClick={onPublish} disabled={dirty || working || nothingToPublish || modelMissing}>
            {busyIcon('publish')}
            {t('product_configurator.studio.actions.publish', 'Publish')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {dirty
            ? t('product_configurator.studio.header.dirtyHint', 'Unsaved changes: save first, Validate and Publish use the saved draft.')
            : localDirty
              ? t('product_configurator.studio.header.localDirtyHint', 'Save or cancel the open editor first.')
              : t('product_configurator.studio.header.cleanHint', 'No unsaved changes.')}
        </p>
      </div>
    </div>
  )
}
