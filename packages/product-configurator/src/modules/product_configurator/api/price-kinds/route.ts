import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import { getEntityIds } from '@open-mercato/shared/lib/encryption/entityIds'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { SortDir, type QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ModelScope } from '../../commands/shared'
import { resolveRouteContext, routeErrorResponse } from '../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['product_configurator.models.manage'] },
}

const READ_PAGE_SIZE = 100

const priceKindsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  ids: z
    .string()
    .optional()
    .transform((value) => Array.from(new Set((value ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0))))
    .pipe(z.array(z.string().uuid()).max(READ_PAGE_SIZE)),
  isActive: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(READ_PAGE_SIZE).default(50),
})

type PriceKindRow = { id: string; code: string; title: string; is_active: boolean | null }

/**
 * Reads every matching kind of the tenant and the organization: price kinds are a short settings list, and the
 * query engine answers an `$ilike` filter through search tokens, which match leading words only.
 */
async function readPriceKinds(queryEngine: QueryEngine, scope: ModelScope, filters: Record<string, unknown>): Promise<PriceKindRow[]> {
  const rows: PriceKindRow[] = []
  for (let page = 1; ; page += 1) {
    const result = await queryEngine.query<PriceKindRow>(getEntityIds().catalog.catalog_price_kind, {
      tenantId: scope.tenantId,
      organizationIds: [scope.organizationId, ''],
      filters,
      fields: ['id', 'code', 'title', 'is_active'],
      sort: [{ field: 'title', dir: SortDir.Asc }],
      page: { page, pageSize: READ_PAGE_SIZE },
    })
    rows.push(...result.items)
    if (result.items.length < READ_PAGE_SIZE || rows.length >= result.total) return rows
  }
}

function matchesSearch(row: PriceKindRow, term: string): boolean {
  return row.title.toLowerCase().includes(term) || row.code.toLowerCase().includes(term)
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const query = priceKindsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
    const filters: Record<string, unknown> = {}
    if (query.ids.length) filters.id = { $in: query.ids }
    const isActive = parseBooleanToken(query.isActive)
    if (isActive !== null) filters.is_active = { $eq: isActive }
    const queryEngine = context.ctx.container.resolve<QueryEngine>('queryEngine')
    const rows = await readPriceKinds(queryEngine, context.scope, filters)
    const term = query.search?.toLowerCase() ?? ''
    const matching = term ? rows.filter((row) => matchesSearch(row, term)) : rows
    const limit = query.ids.length ? query.ids.length : query.pageSize
    return NextResponse.json({
      items: matching.slice(0, limit).map((row) => ({ id: row.id, code: row.code, title: row.title, isActive: row.is_active !== false })),
    })
  } catch (error) {
    return routeErrorResponse(error, 'price_kinds_read')
  }
}

const priceKindsResponseSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), code: z.string(), title: z.string(), isActive: z.boolean() })),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Catalog price kinds for configuration models',
  methods: {
    GET: {
      summary: 'List catalog price kinds a model can price with',
      description:
        'Read-only list of catalog price kinds of the selected organization and tenant-wide kinds, sorted by title. `search` matches any part of the title or code, case-insensitive. `ids` resolves up to 100 kinds by id.',
      query: priceKindsQuerySchema.extend({
        search: z.string().optional().describe('Text contained in the title or code'),
        ids: z.string().optional().describe('Comma-separated price kind ids, at most 100'),
        isActive: z.string().optional().describe('`true` lists active kinds only, `false` inactive ones'),
      }),
      responses: [{ status: 200, description: 'Price kinds', schema: priceKindsResponseSchema }],
      errors: [{ status: 400, description: 'Invalid query or no single organization selected', schema: errorResponseSchema }],
    },
  },
}
