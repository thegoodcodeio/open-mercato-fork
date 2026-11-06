import type { SortingState } from '@tanstack/react-table'

export const MODELS_API_PATH = 'product_configurator/models'
export const MODELS_API_URL = `/api/${MODELS_API_PATH}`
export const MODEL_VERSIONS_API_URL = '/api/product_configurator/model-versions'
export const MODEL_ENTITY_ID = 'product_configurator:configuration_model'
export const MODELS_TABLE_ID = 'product_configurator.models'
export const MODELS_LIST_PAGE_SIZE = 25
export const MODELS_MANAGE_FEATURE = 'product_configurator.models.manage'

export const MODELS_LIST_HREF = '/backend/product_configurator/models'

export type ModelSortField = 'title' | 'modelKey' | 'updatedAt'

const SORT_FIELDS: readonly ModelSortField[] = ['title', 'modelKey', 'updatedAt']

export type ModelListItem = {
  id: string
  productId: string
  modelKey: string
  title: string
  currencyCode: string
  latestVersionId: string | null
  latestVersion: { id: string; version: number; hash: string; publishedAt: string } | null
  hasUnpublishedChanges: boolean
  createdAt: string | null
  updatedAt: string | null
}

export type ModelListResponse = {
  items: ModelListItem[]
  total: number
  totalPages: number
  totalIsCapped?: boolean
}

export type ModelPublishState =
  | { kind: 'not_published' }
  | { kind: 'published'; version: number; hasUnpublishedChanges: boolean }

export type ModelsListFilters = {
  search: string
  published: 'true' | 'false' | null
  currencyCode: string | null
}

export function buildModelStudioHref(modelId: string): string {
  return `${MODELS_LIST_HREF}/${encodeURIComponent(modelId)}`
}

export function buildModelVersionHref(modelId: string, versionId: string): string {
  return `${buildModelStudioHref(modelId)}/versions/${encodeURIComponent(versionId)}`
}

export type ModelOpenTarget = { kind: 'studio'; href: string } | { kind: 'version'; href: string; version: number }

/** The studio needs the manage feature, so a view-only user opens the latest published version instead. */
export function resolveModelOpenTarget(
  model: Pick<ModelListItem, 'id' | 'latestVersion'>,
  canManage: boolean,
): ModelOpenTarget | null {
  if (canManage) return { kind: 'studio', href: buildModelStudioHref(model.id) }
  if (!model.latestVersion) return null
  return { kind: 'version', href: buildModelVersionHref(model.id, model.latestVersion.id), version: model.latestVersion.version }
}

export function resolvePublishState(model: Pick<ModelListItem, 'latestVersion' | 'hasUnpublishedChanges'>): ModelPublishState {
  if (!model.latestVersion) return { kind: 'not_published' }
  return { kind: 'published', version: model.latestVersion.version, hasUnpublishedChanges: model.hasUnpublishedChanges }
}

function isSortField(value: string): value is ModelSortField {
  return (SORT_FIELDS as readonly string[]).includes(value)
}

export function buildModelsListQuery(input: { page: number; filters: ModelsListFilters; sorting: SortingState }): string {
  const params = new URLSearchParams()
  params.set('page', String(input.page))
  params.set('pageSize', String(MODELS_LIST_PAGE_SIZE))
  const search = input.filters.search.trim()
  if (search) params.set('search', search)
  if (input.filters.published) params.set('published', input.filters.published)
  if (input.filters.currencyCode) params.set('currencyCode', input.filters.currencyCode)
  const sort = input.sorting[0]
  if (sort && isSortField(sort.id)) {
    params.set('sortField', sort.id)
    params.set('sortDir', sort.desc ? 'desc' : 'asc')
  }
  return params.toString()
}
