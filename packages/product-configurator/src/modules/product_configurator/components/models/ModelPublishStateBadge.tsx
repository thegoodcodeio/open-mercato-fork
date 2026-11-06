"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { resolvePublishState, type ModelListItem } from './modelsApi'

type ModelPublishStateBadgeProps = Pick<ModelListItem, 'latestVersion' | 'hasUnpublishedChanges'>

export function ModelPublishStateBadge(props: ModelPublishStateBadgeProps) {
  const t = useT()
  const state = resolvePublishState(props)
  if (state.kind === 'not_published') {
    return (
      <StatusBadge variant="neutral" dot>
        {t('product_configurator.models.state.notPublished', 'Not published')}
      </StatusBadge>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge variant="success" dot>
        {t('product_configurator.models.state.published', 'Published v{version}', { version: state.version })}
      </StatusBadge>
      {state.hasUnpublishedChanges ? (
        <StatusBadge variant="warning" dot>
          {t('product_configurator.models.state.unpublishedChanges', 'Unpublished changes')}
        </StatusBadge>
      ) : null}
    </span>
  )
}
