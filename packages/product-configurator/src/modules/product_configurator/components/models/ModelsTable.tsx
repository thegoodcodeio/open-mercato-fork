"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { useLookupLabelMap } from '@open-mercato/ui/backend/inputs/LookupPickers'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { ModelCreateDialog } from './ModelCreateDialog'
import { ModelPublishStateBadge } from './ModelPublishStateBadge'
import { loadCurrencyOptions, productLookupSource } from './lookups'
import {
  CATALOG_PRODUCTS_VIEW_FEATURE,
  CURRENCIES_VIEW_FEATURE,
  MODEL_ENTITY_ID,
  MODELS_API_URL,
  MODELS_LIST_PAGE_SIZE,
  MODELS_MANAGE_FEATURE,
  MODELS_TABLE_ID,
  buildModelStudioHref,
  buildModelsListQuery,
  resolveModelOpenTarget,
  type ModelListItem,
  type ModelListResponse,
  type ModelsListFilters,
} from './modelsApi'

const EMPTY_RESPONSE: ModelListResponse = { items: [], total: 0, totalPages: 1 }

function readPublishedFilter(values: FilterValues): ModelsListFilters['published'] {
  return values.published === 'true' || values.published === 'false' ? values.published : null
}

function readCurrencyFilter(values: FilterValues): string | null {
  return typeof values.currencyCode === 'string' && /^[A-Z]{3}$/.test(values.currencyCode) ? values.currencyCode : null
}

export function ModelsTable() {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload: chrome } = useBackendChrome()
  const canManage = hasFeature(chrome?.grantedFeatures, MODELS_MANAGE_FEATURE)
  const canViewProducts = hasFeature(chrome?.grantedFeatures, CATALOG_PRODUCTS_VIEW_FEATURE)
  const canViewCurrencies = hasFeature(chrome?.grantedFeatures, CURRENCIES_VIEW_FEATURE)
  const [page, setPage] = React.useState(1)
  const [search, setSearch] = React.useState('')
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'updatedAt', desc: true }])
  const [data, setData] = React.useState<ModelListResponse>(EMPTY_RESPONSE)
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

  const filters: ModelsListFilters = {
    search,
    published: readPublishedFilter(filterValues),
    currencyCode: readCurrencyFilter(filterValues),
  }
  const query = buildModelsListQuery({ page, filters, sorting })
  const loadErrorMessage = t('product_configurator.models.list.errors.load', 'Failed to load configuration models.')

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void apiCall<ModelListResponse>(`${MODELS_API_URL}?${query}`, { cache: 'no-store' }).then(
      (call) => {
        if (cancelled) return
        if (call.ok && call.result) {
          setData(call.result)
          setLoadError(null)
        } else {
          setLoadError(loadErrorMessage)
        }
        setIsLoading(false)
      },
      () => {
        if (cancelled) return
        setLoadError(loadErrorMessage)
        setIsLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [query, scopeVersion, loadErrorMessage])

  const productIds = React.useMemo(
    () => (canViewProducts ? data.items.map((item) => item.productId).filter(Boolean) : []),
    [canViewProducts, data.items],
  )
  const productLabels = useLookupLabelMap(productLookupSource, productIds)
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )

  const filterDefs = React.useMemo<FilterDef[]>(
    () => [
      {
        id: 'published',
        type: 'select',
        label: t('product_configurator.models.list.filters.published', 'Publication'),
        options: [
          { value: 'true', label: t('product_configurator.models.list.filters.publishedYes', 'Published') },
          { value: 'false', label: t('product_configurator.models.list.filters.publishedNo', 'Not published') },
        ],
      },
      canViewCurrencies
        ? {
            id: 'currencyCode',
            type: 'select',
            label: t('product_configurator.models.list.filters.currency', 'Currency'),
            loadOptions: loadCurrencyOptions,
          }
        : {
            id: 'currencyCode',
            type: 'text',
            label: t('product_configurator.models.list.filters.currency', 'Currency'),
          },
    ],
    [t, canViewCurrencies],
  )

  const columns = React.useMemo<ColumnDef<ModelListItem>[]>(
    () => [
      {
        id: 'title',
        accessorKey: 'title',
        header: t('product_configurator.models.list.columns.title', 'Title'),
        enableSorting: true,
        meta: { priority: 1 },
        cell: ({ row }) => <span title={row.original.title}>{row.original.title}</span>,
      },
      {
        id: 'modelKey',
        accessorKey: 'modelKey',
        header: t('product_configurator.models.list.columns.key', 'Key'),
        enableSorting: true,
        meta: { priority: 2 },
        cell: ({ row }) => <span className="font-mono text-sm">{row.original.modelKey}</span>,
      },
      ...(canViewProducts
        ? [
            {
              id: 'product',
              header: t('product_configurator.models.list.columns.product', 'Product'),
              enableSorting: false,
              meta: { priority: 3 },
              cell: ({ row }: { row: { original: ModelListItem } }) =>
                productLabels[row.original.productId] ?? <span className="text-muted-foreground">—</span>,
            },
          ]
        : []),
      {
        id: 'currencyCode',
        accessorKey: 'currencyCode',
        header: t('product_configurator.models.list.columns.currency', 'Currency'),
        enableSorting: false,
        meta: { priority: 4 },
      },
      {
        id: 'publishState',
        header: t('product_configurator.models.list.columns.state', 'Publish state'),
        enableSorting: false,
        meta: { priority: 2 },
        cell: ({ row }) => <ModelPublishStateBadge {...row.original} />,
      },
      {
        id: 'updatedAt',
        accessorKey: 'updatedAt',
        header: t('product_configurator.models.list.columns.updatedAt', 'Updated'),
        enableSorting: true,
        meta: { priority: 5 },
        cell: ({ row }) => (row.original.updatedAt ? dateFormatter.format(new Date(row.original.updatedAt)) : null),
      },
    ],
    [canViewProducts, dateFormatter, productLabels, t],
  )

  const hasActiveFilters = filters.published !== null || filters.currencyCode !== null || search.trim().length > 0

  const clearFilters = React.useCallback(() => {
    setFilterValues({})
    setSearch('')
    setPage(1)
  }, [])

  const openStudio = React.useCallback((modelId: string) => router.push(buildModelStudioHref(modelId)), [router])

  const createLabel = t('product_configurator.models.list.actions.create', 'Create model')
  const entityPlural = t('product_configurator.models.list.entityPlural', 'configuration models')

  return (
    <>
      <DataTable<ModelListItem>
        title={t('product_configurator.models.list.title', 'Configuration models')}
        titleHeadingLevel={1}
        entityId={MODEL_ENTITY_ID}
        extensionTableId={MODELS_TABLE_ID}
        columns={columns}
        data={data.items}
        isLoading={isLoading}
        error={loadError}
        actions={canManage ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            {createLabel}
          </Button>
        ) : null}
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value)
          setPage(1)
        }}
        searchPlaceholder={t('product_configurator.models.list.searchPlaceholder', 'Search by title or key')}
        filters={filterDefs}
        filterValues={filterValues}
        onFiltersApply={(values) => {
          setFilterValues(values)
          setPage(1)
        }}
        onFiltersClear={clearFilters}
        filterAwareEmptyState={{
          active: hasActiveFilters,
          entityNamePlural: entityPlural,
          canRemoveLast: filters.published !== null || filters.currencyCode !== null,
          onClearAll: clearFilters,
          onRemoveLast: clearFilters,
        }}
        sorting={sorting}
        onSortingChange={(next) => {
          setSorting(next)
          setPage(1)
        }}
        sortable
        manualSorting
        rowActions={(row) => {
          const target = resolveModelOpenTarget(row, canManage)
          if (!target) return null
          return (
            <RowActions
              items={[
                {
                  id: 'open',
                  label: target.kind === 'studio'
                    ? t('product_configurator.models.list.actions.open', 'Open studio')
                    : t('product_configurator.models.list.actions.viewPublished', 'View published v{version}', { version: target.version }),
                  href: target.href,
                },
              ]}
            />
          )
        }}
        emptyState={(
          <ListEmptyState
            entityName={entityPlural}
            title={t('product_configurator.models.list.empty.title', 'No configuration models yet')}
            description={canManage
              ? t(
                  'product_configurator.models.list.empty.description',
                  'Create a model for a catalog product, then define its features, rules and BOM in the studio.',
                )
              : t(
                  'product_configurator.models.list.empty.descriptionReadOnly',
                  'An administrator creates configuration models for catalog products.',
                )}
            onCreate={canManage ? () => setCreateOpen(true) : undefined}
            createLabel={createLabel}
          />
        )}
        pagination={{
          page,
          pageSize: MODELS_LIST_PAGE_SIZE,
          total: data.total,
          totalPages: data.totalPages,
          totalIsCapped: data.totalIsCapped === true,
          onPageChange: setPage,
        }}
      />
      {canManage ? <ModelCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={openStudio} /> : null}
    </>
  )
}
