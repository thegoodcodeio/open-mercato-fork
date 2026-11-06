import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { DEFINITION_LIMITS, definitionSchema, modelPreviewSchema, type PreviewContextInput } from '../../../data/validators'
import { findLiveModel, modelNotFound } from '../../../commands/shared'
import { evaluationFailed, httpError } from '../../../commands/sessions'
import { evaluateConfiguration } from '../../../lib/evaluation'
import { ConfiguratorEvaluationError } from '../../../lib/evaluator/errors'
import { buildFiredRules } from '../../../lib/previewTrace'
import { pricingPartyExists, type QuoteScope, type ServiceResolver } from '../../../lib/quoteAccess'
import { readLimitedJsonObject, resolveRouteContext, routeErrorResponse } from '../../helpers'
import { errorResponseSchema, productConfiguratorTag } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['product_configurator.models.manage', 'catalog.products.view'] },
}

function previewDate(date: string | null | undefined): Date {
  if (!date) return new Date()
  return new Date(date.length === 10 ? `${date}T00:00:00.000Z` : date)
}

/** No channel, no customer and no date: the model's price kind for nobody in particular, today. */
function isReferenceContext(context: PreviewContextInput | undefined): boolean {
  return !context?.channelId && !context?.customerId && !context?.date
}

async function draftNeedsFix(): Promise<CrudHttpError> {
  const { translate } = await resolveTranslations()
  return new CrudHttpError(422, {
    error: translate(
      'product_configurator.errors.preview_invalid_definition',
      'The saved draft does not match the definition format. Fix it in Advanced (JSON) first.',
    ),
    code: 'invalid_definition',
  })
}

/** The channel and customer of a context must be in the selected organization (404 otherwise). */
async function assertContextInScope(container: ServiceResolver, context: PreviewContextInput | undefined, scope: QuoteScope): Promise<void> {
  if (context?.channelId && !(await pricingPartyExists(container, 'channel', context.channelId, scope))) {
    throw await httpError(404, 'channel_not_found', 'Sales channel not found.')
  }
  if (context?.customerId && !(await pricingPartyExists(container, 'customer', context.customerId, scope))) {
    throw await httpError(404, 'customer_not_found', 'Customer not found.')
  }
}

/**
 * Evaluates the saved draft of a model, priced from the catalog for the given context, without a session.
 * Nothing is stored, so no mutation guards run (like validate).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const context = await resolveRouteContext(req)
    if (context instanceof Response) return context
    const body = await readLimitedJsonObject(req, DEFINITION_LIMITS.evaluateRequestBytes)
    if (body instanceof Response) return body
    const input = modelPreviewSchema.parse(body)
    const em = (context.ctx.container.resolve('em') as EntityManager).fork()
    const model = await findLiveModel(em, input.id, context.scope)
    if (!model) throw await modelNotFound()
    const parsed = definitionSchema.safeParse(model.draftDefinition)
    if (!parsed.success) throw await draftNeedsFix()
    await assertContextInScope(context.ctx.container, input.context, context.scope)

    try {
      const evaluation = await evaluateConfiguration({
        definition: parsed.data,
        modelVersion: { id: model.id, hash: model.draftHash },
        selections: input.selections,
        pricing: {
          em,
          container: context.ctx.container,
          scope: context.scope,
          channelId: input.context?.channelId ?? null,
          customerId: input.context?.customerId ?? null,
          at: previewDate(input.context?.date),
        },
      })
      return NextResponse.json({
        evaluation,
        trace: { firedRules: buildFiredRules(parsed.data, evaluation) },
        referenceContext: isReferenceContext(input.context),
      })
    } catch (error) {
      if (error instanceof ConfiguratorEvaluationError) throw await evaluationFailed(error)
      throw error
    }
  } catch (error) {
    return routeErrorResponse(error, 'models_preview')
  }
}

const previewResponseSchema = z.object({
  evaluation: z
    .record(z.string(), z.unknown())
    .describe(
      'Priced evaluation of the saved draft, the same shape as a session evaluation. `modelVersionId` is the model id and `modelVersionHash` the saved draft hash.',
    ),
  trace: z.object({
    firedRules: z.array(z.object({ ruleId: z.string(), label: z.string().nullable(), effect: z.enum(['error', 'warning', 'force', 'surcharge']) })),
  }),
  referenceContext: z.boolean().describe('True when no channel, customer or date was given (the model price kind, no channel, no customer, now)'),
})

export const openApi: OpenApiRouteDoc = {
  tag: productConfiguratorTag,
  summary: 'Preview a configuration model draft',
  methods: {
    POST: {
      summary: 'Evaluate the saved draft for a pricing context',
      description:
        'Evaluates the choices against the saved draft (not a published version) and prices the BOM from the catalog for the given channel, customer (company or person, with its customer groups at the date) and date; the channel and customer must belong to the selected organization. Without a context it uses the reference context: the model price kind, no channel, no customer, now (the tenant default customer group applies when one exists). No session, snapshot or quote line is created. Returns the rules that fired. Requires a single selected organization and `catalog.products.view`, because it returns catalog prices. The request body is limited to 64 KB.',
      requestBody: { contentType: 'application/json', schema: modelPreviewSchema },
      responses: [{ status: 200, description: 'Evaluation of the saved draft', schema: previewResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid request or no single organization selected', schema: errorResponseSchema },
        { status: 403, description: 'Missing model manage or catalog view access', schema: errorResponseSchema },
        {
          status: 404,
          description: '`model_not_found`, or `channel_not_found` / `customer_not_found` when the context names a channel or customer outside the selected organization',
          schema: errorResponseSchema,
        },
        { status: 413, description: '`payload_too_large`', schema: errorResponseSchema },
        {
          status: 422,
          description:
            '`invalid_definition` (the saved draft does not parse), `invalid_selection` (with `issues`), `forced_value_invalid`, `fixed_point_not_reached`, `expression_error`, `price_missing` (with `params.skus` and `params.channelId`)',
          schema: errorResponseSchema.extend({
            params: z.record(z.string(), z.unknown()).optional(),
            issues: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        },
      ],
    },
  },
}
