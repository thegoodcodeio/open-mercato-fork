import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { modelIdSchema } from '../../../data/validators'
import { findLiveModel, modelNotFound } from '../../../commands/shared'
import { validateModelDraft } from '../../../lib/modelValidation'
import { readJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag, validationReportSchema } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['product_configurator.models.manage', 'catalog.products.view'] },
}

/** Runs the publication checks on the saved draft. Read-only, so no mutation guards run. */
export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const { id } = modelIdSchema.parse(await readJsonObject(req))
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    const model = await findLiveModel(em, id, context.scope)
    if (!model) throw await modelNotFound()
    const report = await validateModelDraft(em, context.ctx.container, model)
    return NextResponse.json(report)
  } catch (error) {
    return routeErrorResponse(error, 'models_validate')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Validate a configuration model draft',
  methods: {
    POST: {
      summary: 'Run the publication checks on the saved draft',
      description:
        'Returns the validation report of the saved draft. Nothing is stored. Requires a single selected organization and the `catalog.products.view` feature, because the report reveals which SKUs exist and their catalog units.',
      requestBody: { contentType: 'application/json', schema: modelIdSchema },
      responses: [{ status: 200, description: 'Validation report', schema: validationReportSchema }],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 404, description: 'Model not found', schema: errorResponseSchema },
      ],
    },
  },
}
