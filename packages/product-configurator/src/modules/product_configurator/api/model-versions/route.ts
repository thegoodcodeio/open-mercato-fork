import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findAndCountWithDecryption, findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ConfigurationModelVersion } from '../../data/entities'
import { modelVersionsQuerySchema } from '../../data/validators'
import { findLiveModel, modelNotFound } from '../../commands/shared'
import { resolveRouteContext, routeErrorResponse } from '../helpers'
import { errorResponseSchema, opaqueDefinitionSchema, productConfiguratorTag, validationReportSchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['product_configurator.models.view'] },
}

const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

async function versionNotFound(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(404, {
    error: translate('product_configurator.errors.version_not_found', 'Model version not found.'),
    code: 'version_not_found',
  })
}

export async function GET(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const params = Object.fromEntries(new URL(req.url).searchParams)
    const query = modelVersionsQuerySchema.parse(params)
    const { tenantId, organizationId } = context.scope
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()

    if (query.id) {
      const version = await findOneWithDecryption(
        em,
        ConfigurationModelVersion,
        { id: query.id, tenantId, organizationId },
        undefined,
        context.scope,
      )
      if (!version) throw await versionNotFound()
      return NextResponse.json({
        id: version.id,
        modelId: version.modelId,
        version: version.version,
        hash: version.hash,
        publishedAt: version.publishedAt.toISOString(),
        definition: version.definition,
        validationReport: version.validationReport,
      })
    }

    const modelId = query.modelId ?? ''
    const model = await findLiveModel(em, modelId, context.scope)
    if (!model) throw await modelNotFound()
    const { page, pageSize } = pagingSchema.parse(params)
    const [versions, total] = await findAndCountWithDecryption(
      em,
      ConfigurationModelVersion,
      { modelId: model.id, tenantId, organizationId },
      {
        fields: ['id', 'modelId', 'version', 'hash', 'publishedAt'],
        orderBy: { version: 'desc' },
        offset: (page - 1) * pageSize,
        limit: pageSize,
      },
      context.scope,
    )
    return NextResponse.json({
      items: versions.map((version) => ({
        id: version.id,
        modelId: version.modelId,
        version: version.version,
        hash: version.hash,
        publishedAt: version.publishedAt.toISOString(),
        isLatest: version.id === model.latestVersionId,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    })
  } catch (error) {
    return routeErrorResponse(error, 'model_versions_read')
  }
}

const versionSummarySchema = z.object({
  id: z.string().uuid(),
  modelId: z.string().uuid(),
  version: z.number().int(),
  hash: z.string(),
  publishedAt: z.string(),
  isLatest: z.boolean(),
})

const versionDetailSchema = versionSummarySchema.omit({ isLatest: true }).extend({
  definition: opaqueDefinitionSchema,
  validationReport: validationReportSchema,
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Published configuration model versions',
  methods: {
    GET: {
      summary: 'List the versions of a model, or read one version',
      description:
        '`modelId` lists the published versions of a model, newest first, without definitions. `id` returns one version with its definition and validation report. Versions are immutable.',
      query: modelVersionsQuerySchema.and(pagingSchema.partial()),
      responses: [
        {
          status: 200,
          description: 'Version list (`modelId`) or one version (`id`)',
          schema: z.union([
            z.object({ items: z.array(versionSummarySchema), total: z.number(), page: z.number(), pageSize: z.number(), totalPages: z.number() }),
            versionDetailSchema,
          ]),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 404, description: 'Model or version not found', schema: errorResponseSchema },
      ],
    },
  },
}
