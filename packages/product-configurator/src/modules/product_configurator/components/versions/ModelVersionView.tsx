"use client"

import * as React from 'react'
import { z } from 'zod'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { CollapsibleSection } from '@open-mercato/ui/backend/SectionHeader'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { definitionSchema } from '../../data/validators'
import { MODEL_VERSIONS_API_URL, MODELS_LIST_HREF, MODELS_MANAGE_FEATURE, buildModelStudioHref } from '../models/modelsApi'
import { DefinitionSections } from './DefinitionSections'

export type ModelVersionDetail = {
  id: string
  modelId: string
  version: number
  hash: string
  publishedAt: string
  definition: unknown
}

type LoadState =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error' }
  | { status: 'ready'; version: ModelVersionDetail }

type ModelVersionViewProps = {
  modelId: string
  versionId: string
}

const idSchema = z.string().uuid()

function SummaryItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  )
}

export function ModelVersionView({ modelId, versionId }: ModelVersionViewProps) {
  const t = useT()
  const locale = useLocale()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload: chrome } = useBackendChrome()
  const canManage = hasFeature(chrome?.grantedFeatures, MODELS_MANAGE_FEATURE)
  const [state, setState] = React.useState<LoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    if (!idSchema.safeParse(modelId).success || !idSchema.safeParse(versionId).success) {
      setState({ status: 'not_found' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    const url = `${MODEL_VERSIONS_API_URL}?id=${encodeURIComponent(versionId)}`
    void apiCall<ModelVersionDetail>(url, { cache: 'no-store' }).then(
      (call) => {
        if (cancelled) return
        if (call.status === 404) return setState({ status: 'not_found' })
        if (!call.ok || !call.result) return setState({ status: 'error' })
        if (call.result.modelId !== modelId) return setState({ status: 'not_found' })
        setState({ status: 'ready', version: call.result })
      },
      () => {
        if (!cancelled) setState({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [modelId, versionId, scopeVersion, reloadToken])

  const parsedDefinition = React.useMemo(
    () => (state.status === 'ready' ? definitionSchema.safeParse(state.version.definition) : null),
    [state],
  )

  if (state.status === 'loading') {
    return <LoadingMessage label={t('product_configurator.versions.loading', 'Loading the published version...')} />
  }
  if (state.status === 'not_found') {
    return (
      <RecordNotFoundState
        label={t('product_configurator.versions.notFound', 'This published version was not found.')}
        backHref={MODELS_LIST_HREF}
        backLabel={t('product_configurator.versions.backToList', 'Back to models')}
      />
    )
  }
  if (state.status === 'error') {
    return (
      <ErrorMessage
        label={t('product_configurator.versions.errors.load', 'Failed to load the published version.')}
        action={(
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            {t('product_configurator.versions.retry', 'Retry')}
          </Button>
        )}
      />
    )
  }

  const { version } = state
  const publishedAt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.publishedAt))
  const definition = parsedDefinition?.success ? parsedDefinition.data : null

  return (
    <div className="space-y-6">
      <FormHeader
        mode="detail"
        backHref={canManage ? buildModelStudioHref(modelId) : MODELS_LIST_HREF}
        backLabel={canManage
          ? t('product_configurator.versions.backToStudio', 'Back to studio')
          : t('product_configurator.versions.backToList', 'Back to models')}
        entityTypeLabel={t('product_configurator.versions.entityType', 'Published version')}
        title={t('product_configurator.versions.title', 'Version {version}', { version: version.version })}
        subtitle={t('product_configurator.versions.readOnly', 'Published versions cannot be changed. Edit the draft in the studio and publish again.')}
      />
      <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label={t('product_configurator.versions.fields.version', 'Version')}>{version.version}</SummaryItem>
        <SummaryItem label={t('product_configurator.versions.fields.publishedAt', 'Published')}>{publishedAt}</SummaryItem>
        <SummaryItem label={t('product_configurator.versions.fields.currency', 'Currency')}>
          {definition?.commercial.currencyCode ?? ''}
        </SummaryItem>
        <SummaryItem label={t('product_configurator.versions.fields.hash', 'Hash')}>
          <span className="font-mono text-xs">{version.hash}</span>
        </SummaryItem>
      </dl>
      {definition ? (
        <DefinitionSections definition={definition} />
      ) : (
        <Alert status="warning">
          <AlertDescription>
            {t('product_configurator.versions.unreadable', 'This version cannot be shown as tables. Its full definition is in the JSON below.')}
          </AlertDescription>
        </Alert>
      )}
      <CollapsibleSection title={t('product_configurator.versions.sections.json', 'Definition (JSON)')} defaultCollapsed>
        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs">
          {JSON.stringify(version.definition, null, 2)}
        </pre>
      </CollapsibleSection>
    </div>
  )
}
