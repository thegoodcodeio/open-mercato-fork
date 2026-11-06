import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { buildIlikeTerm } from '@open-mercato/shared/lib/db/buildIlikeTerm'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ConfigurationModel, ConfigurationModelVersion } from '../../data/entities'
import {
  modelCreateSchema,
  modelIdSchema,
  modelListQuerySchema,
  modelUpdateSchema,
  type ModelListQuery,
} from '../../data/validators'
import { MODEL_ENTITY_TYPE } from '../../commands/shared'
import {
  createPagedListResponseSchema,
  createProductConfiguratorCrudOpenApi,
  opaqueDefinitionSchema,
} from '../openapi'

const rawBodySchema = z.object({}).passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['product_configurator.models.view'] },
  POST: { requireAuth: true, requireFeatures: ['product_configurator.models.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['product_configurator.models.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['product_configurator.models.manage'] },
}

export const metadata = routeMetadata

const listFields = [
  'id',
  'tenant_id',
  'organization_id',
  'product_id',
  'model_key',
  'title',
  'currency_code',
  'draft_hash',
  'latest_version_id',
  'created_at',
  'updated_at',
]
const detailFields = [...listFields, 'draft_definition']

type ModelRow = Record<string, unknown>

type ModelListItem = {
  id: string
  organizationId: string
  productId: string
  modelKey: string
  title: string
  currencyCode: string
  latestVersionId: string | null
  createdAt: string | null
  updatedAt: string | null
  draftHash?: string
  draftDefinition?: unknown
  latestVersion?: { id: string; version: number; hash: string; publishedAt: string } | null
  hasUnpublishedChanges?: boolean
}

function readString(row: ModelRow, key: string): string | null {
  const value = row[key]
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

function toListItem(row: ModelRow): ModelListItem {
  const item: ModelListItem = {
    id: String(row.id),
    organizationId: readString(row, 'organization_id') ?? '',
    productId: readString(row, 'product_id') ?? '',
    modelKey: readString(row, 'model_key') ?? '',
    title: readString(row, 'title') ?? '',
    currencyCode: readString(row, 'currency_code') ?? '',
    latestVersionId: readString(row, 'latest_version_id'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
    draftHash: readString(row, 'draft_hash') ?? '',
  }
  if ('draft_definition' in row) item.draftDefinition = row.draft_definition
  return item
}

/** Adds the latest published version to every row with one grouped query, then drops the internal hash. */
async function attachLatestVersions(payload: { items?: ModelListItem[] }, ctx: CrudCtx): Promise<void> {
  const items = payload.items ?? []
  const tenantId = ctx.auth?.tenantId
  const versionIds = items.map((item) => item.latestVersionId).filter((id): id is string => Boolean(id))
  const versions = new Map<string, ConfigurationModelVersion>()
  if (tenantId && versionIds.length > 0) {
    const em = ctx.container.resolve('em') as EntityManager
    const organizationIds = Array.from(new Set(items.map((item) => item.organizationId)))
    const rows = await findWithDecryption(
      em,
      ConfigurationModelVersion,
      { id: { $in: versionIds }, tenantId, organizationId: { $in: organizationIds } },
      { fields: ['id', 'version', 'hash', 'publishedAt'] },
      { tenantId },
    )
    for (const row of rows) versions.set(row.id, row)
  }
  for (const item of items) {
    const version = item.latestVersionId ? versions.get(item.latestVersionId) : undefined
    item.latestVersion = version
      ? { id: version.id, version: version.version, hash: version.hash, publishedAt: version.publishedAt.toISOString() }
      : null
    item.hasUnpublishedChanges = version ? version.hash !== item.draftHash : false
    delete item.draftHash
  }
}

type ModelListCtx = Pick<CrudCtx, 'selectedOrganizationId' | 'organizationIds' | 'auth'>

const NO_ROWS = { id: { $in: [] } }

/**
 * The route sets `omitAutomaticTenantOrgScope`, so these filters carry the whole tenant and organization scope
 * and fail closed without one. That option also keeps `search` a plain `$ilike`: the default query path answers
 * `$ilike` on an indexed entity through search tokens, which drop short and non-word parts of a key.
 * Lists only the selected organization (not its children), the same scope the commands write to.
 */
export function buildModelListFilters(query: ModelListQuery, ctx: ModelListCtx): Record<string, unknown> {
  const tenantId = ctx.auth?.tenantId
  const organizationIds = ctx.selectedOrganizationId ? [ctx.selectedOrganizationId] : ctx.organizationIds
  if (!tenantId || organizationIds?.length === 0) return { ...NO_ROWS }
  const filters: Record<string, unknown> = { tenant_id: { $eq: tenantId } }
  if (organizationIds) filters.organization_id = organizationIds.length === 1 ? { $eq: organizationIds[0] } : { $in: organizationIds }
  if (query.id) filters.id = { $eq: query.id }
  if (query.productId) filters.product_id = { $eq: query.productId }
  if (query.currencyCode) filters.currency_code = { $eq: query.currencyCode }
  if (query.published === 'true') filters.latest_version_id = { $exists: true }
  if (query.published === 'false') filters.latest_version_id = { $exists: false }
  if (query.search) {
    const pattern = buildIlikeTerm(query.search)
    filters.$or = [{ title: { $ilike: pattern } }, { model_key: { $ilike: pattern } }]
  }
  return filters
}

async function parseBody<T>(schema: z.ZodType<T>, raw: unknown): Promise<T> {
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const { translate } = await resolveTranslations()
  throw new CrudHttpError(400, {
    error: translate('product_configurator.errors.invalid_request', 'Invalid request.'),
    code: 'invalid_request',
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  })
}

const crud = makeCrudRoute<unknown, unknown, ModelListQuery>({
  metadata: routeMetadata,
  orm: {
    entity: ConfigurationModel,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: MODEL_ENTITY_TYPE },
  list: {
    schema: modelListQuerySchema,
    entityId: MODEL_ENTITY_TYPE,
    fields: (query) => (query.id ? detailFields : listFields),
    sortFieldMap: { title: 'title', modelKey: 'model_key', updatedAt: 'updated_at' },
    defaultSort: { field: 'updated_at', dir: 'desc' },
    disableListCache: true,
    omitAutomaticTenantOrgScope: true,
    buildFilters: (query, ctx) => buildModelListFilters(query, ctx),
    transformItem: (row: ModelRow) => toListItem(row),
  },
  hooks: {
    afterList: (payload, ctx) => attachLatestVersions(payload, ctx),
  },
  actions: {
    create: {
      commandId: 'product_configurator.models.create',
      schema: rawBodySchema,
      mapInput: ({ raw }) => parseBody(modelCreateSchema, raw),
      response: ({ result }) => ({ id: result?.id ?? null }),
      status: 201,
    },
    update: {
      commandId: 'product_configurator.models.update',
      schema: rawBodySchema,
      mapInput: ({ raw }) => parseBody(modelUpdateSchema, raw),
      response: ({ result }) => ({
        id: result?.id ?? null,
        updatedAt: result?.updatedAt ?? null,
        draftHash: result?.draftHash ?? null,
      }),
    },
    delete: {
      commandId: 'product_configurator.models.delete',
      schema: rawBodySchema,
      mapInput: ({ parsed, raw, ctx }) => {
        const queryId = ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null
        return parseBody(modelIdSchema, { id: raw?.id ?? parsed?.body?.id ?? parsed?.id ?? queryId })
      },
      response: () => ({ ok: true }),
    },
  },
})

export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

export async function GET(req: Request): Promise<Response> {
  const response = await crud.GET(req)
  const requestedId = new URL(req.url).searchParams.get('id')
  if (!requestedId || response.status !== 200) return response
  const payload = await readJsonSafe<{ items?: unknown[] }>(response.clone(), null)
  if (payload?.items && payload.items.length > 0) return response
  const { translate } = await resolveTranslations()
  return NextResponse.json(
    { error: translate('product_configurator.errors.model_not_found', 'Configuration model not found.'), code: 'model_not_found' },
    { status: 404 },
  )
}

const latestVersionSchema = z
  .object({ id: z.string().uuid(), version: z.number().int(), hash: z.string(), publishedAt: z.string() })
  .nullable()

const modelListItemSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  productId: z.string().uuid(),
  modelKey: z.string(),
  title: z.string(),
  currencyCode: z.string(),
  latestVersionId: z.string().uuid().nullable(),
  latestVersion: latestVersionSchema,
  hasUnpublishedChanges: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  draftDefinition: opaqueDefinitionSchema.optional().describe('Returned only when `id` is given (studio detail).'),
})

export const openApi = createProductConfiguratorCrudOpenApi({
  resourceName: 'ConfigurationModel',
  pluralName: 'ConfigurationModels',
  querySchema: modelListQuerySchema,
  listResponseSchema: createPagedListResponseSchema(modelListItemSchema),
  create: {
    schema: modelCreateSchema.extend({ draftDefinition: opaqueDefinitionSchema.optional() }),
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description:
      'Creates a configuration model bound to a catalog product. Without `draftDefinition` the draft is an empty skeleton with the given currency and price kind. 409 `duplicate_model_key` when the key is taken in the organization.',
  },
  update: {
    schema: z.object({ id: z.string().uuid(), title: z.string().optional(), draftDefinition: opaqueDefinitionSchema.optional() }),
    responseSchema: z.object({
      id: z.string().uuid().nullable(),
      updatedAt: z.string().nullable(),
      draftHash: z
        .string()
        .nullable()
        .describe('Hash of the saved draft. Equals `latestVersion.hash` when the draft matches the latest published version.'),
    }),
    description:
      'Saves the title and/or the draft definition. Send the optimistic-lock header with the last seen `updatedAt`. 400 `invalid_definition` when the draft is too large, too deeply nested or changes the model currency.',
  },
  del: {
    schema: modelIdSchema,
    description: 'Soft-deletes a configuration model. Published versions stay. Send the optimistic-lock header.',
  },
})
