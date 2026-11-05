import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { modelIdSchema, type ModelIdInput } from '../../../data/validators'
import { MODEL_RESOURCE_KIND } from '../../../commands/shared'
import type { ModelPublishResult } from '../../../commands/models'
import { readJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag, validationReportSchema } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['product_configurator.models.manage', 'catalog.products.view'] },
}

export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const input = modelIdSchema.parse(await readJsonObject(req))
    const guard = await runRouteMutationGuards({
      container: context.ctx.container,
      req,
      auth: { userId: context.userId, tenantId: context.scope.tenantId, organizationId: context.scope.organizationId },
      input: { resourceKind: MODEL_RESOURCE_KIND, resourceId: input.id, operation: 'custom', mutationPayload: { ...input } },
    })
    if (!guard.ok) return guard.response
    const commandInput = guard.modifiedPayload ? modelIdSchema.parse(guard.modifiedPayload) : input

    const commandBus = context.ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<ModelIdInput, ModelPublishResult>('product_configurator.models.publish', {
      input: commandInput,
      ctx: context.ctx,
    })
    await guard.runAfterSuccess()
    return NextResponse.json(result)
  } catch (error) {
    return routeErrorResponse(error, 'models_publish')
  }
}

const publishResponseSchema = z.object({
  modelVersionId: z.string().uuid(),
  version: z.number().int(),
  hash: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Publish a configuration model',
  methods: {
    POST: {
      summary: 'Freeze the saved draft as a new immutable version',
      description:
        'Runs the publication checks on the saved draft and, when they pass, stores a new version with the definition hash and the validation report and makes it the latest version. Send the optimistic-lock header with the model `updatedAt`. Requires the `catalog.products.view` feature, because the checks and the report read catalog SKUs and units.',
      requestBody: { contentType: 'application/json', schema: modelIdSchema },
      responses: [{ status: 200, description: 'Published version', schema: publishResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 404, description: 'Model not found', schema: errorResponseSchema },
        { status: 409, description: 'Optimistic-lock conflict or the draft changed during publish', schema: errorResponseSchema },
        {
          status: 422,
          description: '`validation_failed` with the report, or blocked by a mutation guard',
          schema: errorResponseSchema.extend({ report: validationReportSchema.optional() }),
        },
      ],
    },
  },
}
